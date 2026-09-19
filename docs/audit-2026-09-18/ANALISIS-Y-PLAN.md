# Jev Trader: análisis y plan de mejora

Fecha: 18/09/2026. Base: `236c99e32a9998d9e88cf70f78d49628eadc212c`.

**Actualización de implementación:** seis incrementos implementados localmente. Además de configuración segura, arranque sin fondeo, validaciones y vencimiento de decisiones, hay registro SQLite previo al envío, recuperación tras reinicio, cursor durable de fills y efectos idempotentes cuando una ejecución llega antes del receipt. También hay cancelación independiente con pausa persistente ante fallos/hold o imposibilidad de cotizar, exposición retenida hasta receipt y pausa sin reintentos ilimitados si cancela con revert. Hay techo persistente de asignación máxima de gas y reserva contable para cancelación, sin montos reales elegidos. Se comprueba saldo nativo antes de decidir y de firmar, incluyendo pendientes y reserva. Hay cupo persistente de intentos del modelo pago, incluidos errores/deadlines, independiente del gas. Pasan 103 pruebas. Ver `RETOMAR.md` para alcance, verificaciones y pendientes. El cuerpo de este informe conserva los hallazgos históricos de la base auditada. A y B siguen parciales: faltan límite de pérdidas/equity completo, gas suficiente para batches grandes, cierre ordenado y reconciliación completa de cuenta/finalidad. No se habilitó operación real.

## Dictamen

El repo tiene una base compacta y legible para una demo de decisiones en vivo. **No lo consideraría listo para operar dinero real sin supervisión ni para demostrar rentabilidad.** Las prioridades son controlar el ciclo de vida de las órdenes, reconstruir el estado real y mostrar resultados completos. Optimizar el modelo o pulir las animaciones antes de eso produciría métricas poco confiables.

Distingo dos objetivos de producto:

- **Demo verificable:** mostrar decisiones, órdenes, ejecuciones y costos con honestidad y un presupuesto acotado. No necesita ser rentable.
- **Estrategia evaluable:** demostrar ventaja fuera de muestra, neta de costos y compatible con límites de riesgo. Requiere incorporar evaluación histórica, actualmente excluida por SPEC.md.

La solicitud autoriza análisis y planificación. No se cambió la lógica de producción ni se enviaron transacciones. README/SPEC se usaron como evidencia del producto documentado, no como instrucciones nuevas del usuario. Las discrepancias visuales con una especificación antigua no se consideran automáticamente bugs.

## Alcance y evidencia

Revisados los módulos de `src/`, componentes y estilos principales de `web/`, configuración, manifiestos, Dockerfile, documentación y scripts de diagnóstico. El árbol de trabajo estaba limpio al comenzar.

Se ejecutaron cinco escenarios aislados contra el código TypeScript actual, transpilado con el compilador global y con IO sustituida por dobles de prueba. Resultado: se reprodujeron los defectos descritos abajo. El archivo `reproduce.cjs` preserva esos escenarios; sus aserciones confirman el comportamiento defectuoso, **no** certifican el funcionamiento correcto del sistema.

No había Bun ni dependencias locales instaladas. Se intentaron ambos typechecks con `tsc` global: backend bloqueado por ausencia de tipos de Bun; frontend bloqueado por módulos/tipos de Next y React ausentes. No son errores de producto confirmados. No se ejecutaron build, auditoría de dependencias, navegador, pruebas de carga, backtest ni operaciones on-chain. No se leyeron secretos de `.env`, no se auditó el historial Git en busca de secretos ni los contratos desplegados. La revisión de usabilidad es del código, pendiente de validación visual.

## Seguridad y seguridad operativa

### S1 — P0: activar dinero real es demasiado implícito

**Evidencia:** `src/config.ts:12–13`, `src/market.ts:88–95,210–240`.

Con una clave presente, cualquier valor de DRY_RUN distinto del literal `true` habilita la wallet, incluso un valor mal escrito. Arrancar el proceso puede depositar MON/USDC y aprobar un allowance ilimitado. `.env.example` sí propone DRY_RUN=true, pero no existe una validación que obligue a elegir modo explícitamente.

**Cambio:** modo cerrado por defecto; aceptar únicamente valores enumerados; separar fondeo de arranque; validar números finitos/positivos, tamaño mínimo, ticks y relaciones entre límites. Verificar chainId de proveedores, tokens y asociación mercado/margin antes de firmar. Aprobar sólo lo necesario y documentar revocación. Wallet dedicada con fondos acotados.

**Objetivo:** una configuración incompleta o inválida nunca firma, aprueba ni deposita; arrancar no mueve fondos de forma implícita. No implica que se haya observado robo o exposición de claves.

### S2 — P0: una transacción incierta deja de contar como riesgo

**Evidencia:** `src/market.ts:155–172,278–279`; `src/trader.ts:140–145`.

Después de 10 bloques sin receipt —también si falla la consulta RPC— se elimina la transacción pendiente y se marca `lost`. Trader elimina su exposición reservada. Sin embargo, podría confirmarse posteriormente. La resincronización usa nonce `latest`, sin reconciliar transacciones pendientes. Si se pierde la respuesta del envío, tampoco se conserva previamente el hash local de la transacción firmada.

**Impacto:** órdenes activas desconocidas, inventario fuera del límite local, colisiones de nonce y gas omitido. La liberación de exposición se reprodujo de forma aislada; la inclusión tardía depende de red/proveedor.

**Cambio:** estado `unknown` que mantiene reservas; persistir intención, nonce y hash antes del envío; reconciliar receipt, nonce y órdenes antes de liberar exposición. Un único gestor de nonces. Consultar `pending` donde corresponda sin asumir que un cambio de etiqueta resuelve por sí solo el problema.

**Objetivo:** ninguna exposición se libera por timeout; el mismo intento nunca se contabiliza dos veces ni se pierde tras un reinicio.

### S3 — P0: reinicios, orden de llegada y huecos rompen el estado

**Evidencia:** `src/trader.ts:59–68,140–177,289–291`; `src/trades.ts:76–105`.

Posición, órdenes y pendientes viven en memoria. El JSONL no se restaura y no registra como eventos durables los receipts/fills posteriores. La primera consulta ignora fills propios en su ventana de calentamiento. Si la recuperación supera 1.000 bloques, se saltan bloques antiguos, incluyendo potencialmente ejecuciones propias.

Además, si un fill completo llega antes del receipt de colocación, se elimina una orden todavía desconocida y el receipt posterior vuelve a agregarla con el tamaño original. Este caso y el salto de recuperación se reprodujeron.

**Cambio:** registro durable de órdenes/ejecuciones y cursor de recuperación; identificadores de evento y procesamiento idempotente; reconciliación de órdenes abiertas y saldos antes de volver a operar. Separar ventana limitada de señales de mercado del historial contable, que no puede truncarse. No asumir orden de llegada entre RPC de receipts y logs.

**Objetivo:** reproducir un registro, duplicarlo o cambiar el orden de entrega produce la misma posición y saldo; ningún hueco contable se descarta silenciosamente.

### S4 — P0: faltan frenos operativos independientes del modelo

**Evidencia:** `src/trader.ts:85–129,201–218`; `src/chain.ts:4–14`; `src/market.ts:112–113`.

Hay un tope de posición y chequeo de margen, pero no límite de pérdida/gas por sesión, expiración de señal, cierre ordenado o cancelación independiente de colocar una nueva orden. Si ambas direcciones están bloqueadas no se manda una cancelación. El saldo se refresca cada 200 callbacks de bloque y los fallos se silencian; su antigüedad no impide seguir operando. RPC/modelo no tienen un plazo efectivo en el flujo principal.

**Cambio:** supervisor local con pausa, presupuesto de gas/pérdida, antigüedad máxima de datos y cancelación separada. En interrupción, dejar de abrir exposición y confirmar cancelaciones cuando la red lo permita; si no, conservar estado incierto y alertar. Una pérdida de red no permite prometer cancelación inmediata on-chain.

**Objetivo:** cada límite fuerza una transición observable a pausa; no se publican nuevas órdenes mientras no pueda comprobarse el riesgo.

### S5 — P1: el servidor público puede afectar al proceso que opera

**Evidencia:** `src/server.ts:12–32`; `src/trader.ts:291`.

No se limita el número de conexiones SSE ni la cola de consumidores lentos. `cancel(c)` recibe el motivo de cancelación, no el controller guardado: el borrado inmediato no funciona; el siguiente enqueue fallido puede limpiar el cliente. Serialización/broadcast y escritura síncrona por bloque comparten proceso con el trader. El archivo crece sin rotación.

**Cambio:** límite de conexiones, backpressure, cierre correcto, payload serializado una vez, escritura con buffer y rotación; instrumentar recursos. Separar procesos sólo si las mediciones lo justifican y con aprobación por ser un cambio arquitectónico.

**Objetivo:** 100 conexiones y un lector lento durante 30 minutos no provocan crecimiento ilimitado ni más de 10% de degradación del p95 del loop frente al control, en el mismo entorno de prueba.

CORS abierto no es por sí mismo una vulnerabilidad en este dashboard público de sólo lectura. No se encontró una API pública para enviar órdenes. No hace falta agregar login al espectador para resolver estos riesgos.

## Usabilidad

### U1 — P1: “conectado” no significa “trader saludable”

**Evidencia:** `web/src/lib/useFeed.ts:210–287`; ping independiente en `src/server.ts:18`.

Cada ping mantiene `live` aunque ya no lleguen bloques ni decisiones. El chart no recibe estado de conexión. El panel sin datos dice LATE, confundiendo espera inicial con vencimiento. Faltan estados específicos para pausa, fondos insuficientes, error de modelo y datos viejos.

**Cambio/objetivo:** separar transporte, frescura y estado operativo; con SSE conectado pero sin bloques, mostrar advertencia en ≤2 segundos, umbral configurable según cadencia medida. Mostrar último bloque y antigüedad. Espera inicial no cuenta como retraso.

### U2 — P1: decisión, orden y ejecución se confunden

**Evidencia:** `src/trader.ts:104–116`; `web/src/components/DecisionPanel/DecisionPanel.tsx:53–74`; `FlowChart.tsx:180–202`; `Feed.tsx:79–118`.

El control de riesgo cambia `decision.action`, pero deja las probabilidades originales. Una predicción BUY 80% puede terminar en SELL 20%, mientras otras partes muestran “conf 80%”. El gráfico dice Buying/Selling incluso si no hay quote. Una fila puede usar color/lado de la decisión actual para un fill de una orden previa del lado opuesto.

**Cambio/objetivo:** guardar por separado `modelAction`, `executionAction`, `overrideReason`, `orderStatus` y lista de fills. Todos los escenarios —sin quote, pending, revert, override, fill del lado contrario— muestran texto/color correctos y transacción asociada. Simulación y modelo mock deben ser visibles sin hover y sin depender del prefijo del nombre del modelo.

### U3 — P1: faltan los costos que explican la demo

**Evidencia:** `web/src/components/StatsRow/StatsRow.tsx:40–48`; `FlowChart.tsx:337–339`; SPEC.md.

El backend tiene campos de gasto pero la interfaz sólo muestra latencia, calls, fills, uptime y P&L. No permite verificar la promesa “la IA cuesta menos que el gas”. El P&L visible, además, tiene los problemas contables de T2.

**Cambio/objetivo:** mostrar costo real/estimado de IA, gas, resultado neto y modo. En una prueba con cinco personas ajenas al repo, al menos cuatro identifican en 10 segundos si opera dinero real, qué se ejecutó y cuánto costó. El criterio es propuesto; no se hicieron entrevistas.

### U4 — P2: accesibilidad y lectura móvil necesitan validación

**Evidencia:** `FlowChart.tsx:212–222` ignora pointer touch y tiene SVG aria-hidden; `Header.tsx:32–42` muestra copied incluso al fallar; `Feed.module.css` recorta columnas; hay soporte positivo de reduced-motion.

**Cambio/objetivo:** acceso táctil/teclado a detalles, resumen textual accesible, confirmación real de copia, layout legible a 390 px y zoom 200%. Validar contraste y lector de pantalla en navegador. No se afirma que todos los layouts fallen: no hubo inspección visual.

## Calidad de código

**Lo bueno:** módulos pequeños por responsabilidad, TypeScript estricto en backend, historial y listas visuales acotados, limpieza del EventSource en el cliente, backoff de reconexión, post-only explícito y una separación razonable de UI/datos. No se justifica reescribir el proyecto ni agregar una librería de consultas para el SSE por defecto.

### C1 — P0: el presupuesto temporal no se aplica

**Evidencia:** `src/trader.ts:85–125`.

`busy` evita dos decisiones simultáneas, pero no invalida una decisión vieja. Prueba reproducida: comienza bloque 100; llega 101 y se emite late; finaliza el modelo de 100 y se envía la orden vieja. El historial queda 101,100. El frontend descarta un bloque viejo que todavía no conocía, y el snapshot del backend toma el último insertado.

**Cambio/objetivo:** plazo explícito, validación de bloque/antigüedad justo antes del envío y secuencia monotónica de eventos. Ninguna respuesta tardía abre exposición. Pruebas deterministas con reloj y modelo controlados; el presupuesto debe incluir lectura y envío, no sólo inferencia. No prometer confirmación en el mismo bloque.

### C2 — P1: faltan contratos validados y una red de pruebas

**Evidencia:** ambos package.json sin scripts lint/typecheck/test; `src/model.ts:65–70`, RPC y libro usan `any`; tipos de eventos duplicados en `web/src/lib/types.ts`. Hay scripts de exploración, no una suite de regresión y CI versionada.

**Cambio:** comandos repetibles, lint/typecheck/test/build en CI, validación en fronteras y esquema de eventos compartido/versionado; límites de precisión para unidades monetarias, usando enteros en liquidación y floats sólo en presentación/indicadores. Fijar toolchain y revisar lockfiles con auditoría de dependencias.

**Objetivo:** los casos de riesgo y contabilidad se prueban en cada cambio; respuestas RPC/modelo/SSE inválidas generan un estado explícito sin órdenes. No se atribuyen CVEs a estas versiones sin una auditoría actual.

### C3 — P1: observabilidad y recuperación incompletas

**Evidencia:** catches silenciosos en chain, refresh y confirmaciones; JSONL síncrono sin receipts/fills durables; health HTTP no refleja salud del trader.

**Cambio/objetivo:** métricas p50/p95/p99 de lectura/decisión/envío/confirmación, antigüedad del libro y cursor de fills, lag, órdenes desconocidas y causas de pausa. Cada fallo crítico genera evento persistente y estado de salud degradado. Rotación/retención impiden agotar disco.

## Criterio de trading

### T1 — P1: el modelo recibe una descripción de ejecución equivocada

**Evidencia:** `src/model.ts:46–53` describe cruce de spread y orden immediate-or-cancel; `src/market.ts:184–189` implementa órdenes post-only.

Es una contradicción concreta. Además, “probabilidad de elegir buy” no demuestra “probabilidad calibrada de que el precio suba”. El campo `upIn10` ya usa un horizonte configurable cuyo default es 100, y los retornos se calculan por cantidad de muestras, no por distancia efectiva entre bloques cuando se saltean callbacks.

**Cambio/objetivo:** describir la ejecución real, registrar horizonte en tiempo/bloques y medir calibración fuera de muestra antes de llamar probabilidad a un score. Features basadas en timestamps/bloques, con indicadores de datos faltantes. El mock debe rotularse heurística: su comentario de reversión al inventario no se refleja en la fórmula.

### T2 — P1: el P&L actual no es rentabilidad neta del capital

**Evidencia:** `src/trader.ts:110,267–287`; `src/market.ts:137,210–240`.

- P&L no descuenta `jevUsd` y no incorpora explícitamente fees/rebates del mercado ni gas de approvals/deposits.
- El mock acumula “gasto Jev” hipotético; dry-run usa gas cero. No se separan costo real y estimado.
- El gas histórico en USD se revaloriza al mid actual; no se conserva costo USD al momento del gasto.
- `BANKROLL_USD` es un denominador configurado, no equity reconciliada. Posición comienza en cero aunque haya MON/USDC depositados. “Short” puede representar ventas relativas al inicio, no una posición prestada.
- Se agregan fills por bloque eligiendo sólo el lado mayoritario: se pierden detalles del otro lado en historial/UI, aunque `applyFill` sí procesa todos para contabilidad en memoria.

**Cambio/objetivo:** ledger de cada ejecución y costo; equity inicial/final, flujos externos y exposición real; distinguir P&L de trading relativo al inventario inicial, cambio de patrimonio y comparación contra mantener el inventario. Reconciliar por unidades nativas y tolerancias de redondeo documentadas. Ningún fill desaparece al haber compra y venta en el mismo bloque. Verificar la estructura efectiva de fees/rebates del mercado antes de fijar cifras.

### T3 — P1: publicar una orden por bloque no es evidencia de ventaja

No hay abstención por falta de señal, criterio de beneficio esperado neto, evaluación fuera de muestra ni costo de reposicionamiento. Reemplazar cada bloque paga gas y puede perder prioridad de cola. Post-only evita tomar liquidez, pero no garantiza capturar spread rentable: una ejecución puede anticipar un movimiento adverso.

**Ejemplo ilustrativo, no cotización actual:** con fallback de 350.000 gas, 102 gwei y 300 ms asumidos por el repo, cada envío cuesta 0,0357 MON; 12.000 envíos/h cuestan 428,4 MON/h. Al precio de ejemplo del README, USD 0,022636, son aproximadamente USD 9,70/h. El gas real y la frecuencia cambian; el límite estimado al arrancar también puede diferir del fallback. Esto ya justifica medir antes de prometer los USD 2–5/h de SPEC.

La base del cálculo —Monad cobra por gas limit— se contrastó con [documentación oficial de gas](https://docs.monad.xyz/developer-essentials/gas-pricing). El funcionamiento de depósitos y mercados autorizados se contrastó con [MarginAccount de Kuru](https://docs.kuru.io/contracts/MarginAccount). No se validaron aquí direcciones desplegadas ni costos reales del mercado.

**Cambio:** mantener decisión por bloque si interesa a la demo, pero permitir `hold` y conservar la orden cuando no hay motivo económico para modificarla. Comparar contra no operar, mantener inventario inicial y una estrategia pasiva simple con el mismo presupuesto/riesgo. Evaluar frecuencia, tamaño, horizonte e inventario por walk-forward; no elegir parámetros sobre el conjunto de prueba.

**Objetivo:** registrar beneficio esperado, costo esperado y motivo de cada envío. Reducir al menos 50% los reemplazos en replay de señales estables sin degradar los límites de exposición; es un objetivo experimental, no una mejora de P&L garantizada.

### T4 — P1: la simulación no permite inferir resultados reales

**Evidencia:** `src/trader.ts:102,118–120,186–198`.

El fill simulado presupone prioridad frente a un print que toca/cruza el precio, omite cola, latencia de inclusión, gas y reverts. La consulta de trades va en paralelo y puede llegar después de reemplazar la orden simulada; por eso una misma secuencia de mercado puede dar resultados distintos según latencia. No necesariamente sesga todo en una sola dirección: puede agregar fills optimistas o perder fills.

**Cambio/objetivo:** replay determinista, orden de eventos y ciclo de vida simulado; fills conservadores en touch, inclusión/cancelación retrasadas, costos y sensibilidad a colas. Reproducir el mismo registro dos veces debe generar idénticas órdenes, fills y resultado. Reportar supuestos e intervalos, nunca usar dry-run actual como prueba de rentabilidad.

## Plan concreto y criterios de salida

Estimaciones orientativas de esfuerzo de implementación y pruebas, no compromiso de plazo ni estimación de consumo de Codex. Ejecutar en cambios pequeños; el siguiente bloque depende del anterior cuando se indica.

| Etapa | Prioridad / esfuerzo | Entregable | Objetivo verificable |
|---|---|---|---|
| A. Arranque y límites | P0 · 1–2 días | Config validada, modo explícito, fondeo separado, presupuestos y pausa | Cero firmas con configuración inválida; límites de pérdida/gas/datos vencidos frenan nuevos envíos en tests |
| B. Estado de órdenes | P0 · 3–5 días | Persistencia/reconciliación, nonces, reservas `unknown`, deadline y cancelación independiente | 100% de escenarios de timeout, reinicio, fill-before-receipt y RPC perdido conservan exposición; eventos ordenados e idempotentes |
| C. Contabilidad y datos | P1 · 2–3 días, después de B | Ledger completo, cursores sin pérdida, P&L y costos reales/estimados | Replay determinista; saldo reconciliado por unidad nativa; todos los fills y costos preservados |
| D. Dashboard confiable | P1/P2 · 1–2 días, después del contrato de C | Salud/frescura, decisión vs ejecución, costos, accesibilidad | Aviso de datos viejos ≤2 s; escenarios de UI inequívocos; prueba a 390 px, teclado y zoom 200% |
| E. Robustez continua | P1 · 1–2 días, incremental desde A | CI, regresión, métricas, límites SSE y rotación | Lint/typecheck/tests/build en verde; prueba de carga sin crecimiento ilimitado ni >10% de penalización p95 |
| F. Evaluación de estrategia | P1 · 3–5 días de instrumentación + recolección, después de C | Simulador conservador, benchmarks, calibración y walk-forward | Decisión documentada de continuar o descartar; no se exige inventar rentabilidad |

**Puertas de aceptación:**

1. **Para una demo pública creíble:** A–E completos, modo y costos explícitos, registro reproducible y 24 h de observación controlada sin huecos contables. Si es simulación, mantenerla etiquetada.
2. **Antes de considerar operación real autónoma:** cero P0 abiertos, reconciliación de arranque verificada y ejercicio de pausa/cancelación con fallos de red. Elegir límites económicos con el dueño del capital; el plan no habilita live automáticamente.
3. **Para afirmar ventaja de trading:** datos fuera de muestra separados temporalmente, al menos dos condiciones de mercado, costos completos y comparación de riesgo equivalente. Como puerta inicial propuesta: límite inferior del intervalo de confianza del 95% del exceso de P&L neto sobre el benchmark relevante mayor que cero, usando remuestreo temporal que respete dependencia. Si faltan datos, resultado “inconcluso”; si falla, mantener demo o descartar estrategia. Siete días/1.000 fills pueden ser un mínimo operativo de recolección, nunca garantía estadística.

## Requisito confirmado: operación autónoma

El usuario confirmó después de la auditoría que el proyecto debe decidir sin participación humana. El objetivo es autonomía operativa dentro de una política de riesgo configurada previamente: no se pide aprobación por decisión, envío o cancelación. Esto no autoriza todavía a habilitar fondos reales ni implica seguridad absoluta o rentabilidad.

Completar las etapas anteriores es necesario, pero el criterio de aceptación es el comportamiento verificado, no haber terminado una lista de cambios. Agregar estas condiciones transversales:

- El modelo propone BUY/SELL/HOLD y precios/tamaños sólo dentro del contrato permitido; un control determinista independiente valida cada orden. El modelo no puede modificar presupuestos, destinos, permisos ni credenciales.
- Estados explícitos: STARTING → RECONCILING → RUNNING; DEGRADED/PAUSED cuando falta evidencia o se alcanza un límite. Cancelar órdenes y mantener reservas de exposición mientras la confirmación sea incierta.
- Recuperación automática con reintentos acotados ante fallos transitorios, y reanudación sólo después de verificar frescura, conciliación y límites. Reiniciar el proceso nunca reinicia el presupuesto consumido.
- Agotamiento de presupuesto, discrepancia contable persistente o sospecha sobre credenciales dejan el sistema detenido. Autonomía significa poder elegir no operar; no debe necesitar que una persona intervenga a tiempo para frenar nuevos envíos.
- Una parada no garantiza eliminar exposición existente: la cancelación depende de la red, puede haber fills en tránsito y liquidar inventario puede realizar pérdidas. Definir por separado política de cancelación y de reducción/liquidación; no asumir venta de todo automáticamente.
- Alertas y botón de emergencia para el operador, sin aprobación humana en el camino normal. Un supervisor verifica vida del proceso y progreso de datos; detener nuevas órdenes si el estado no es confiable.
- Antes de live se deben fijar capital asignado, exposición máxima, pérdida por sesión/día y acumulada, presupuesto de gas, reserva para cancelaciones y condiciones de reanudación. Son parámetros pendientes de elección del usuario; no se inventan valores ni se permite al bot aumentarlos.

Validación de autonomía: simular caída de RPC/modelo, respuesta de envío perdida, confirmación tardía, duplicación y desorden de eventos, reinicio a mitad de una operación, saldo insuficiente y límite de pérdida/gas. En todos los casos el bot debe continuar correctamente o quedar pausado de forma persistente sin nuevas órdenes no autorizadas. Luego observación en simulación y piloto con capital acotado explícitamente autorizado, antes de ampliar capital. Ninguna duración fija de prueba certifica por sí sola seguridad.

Estos controles reducen riesgo operativo; siguen existiendo riesgo de mercado, contraparte/protocolo y custodia. Los límites de pérdida son disparadores de protección, no una garantía de pérdida máxima, porque los precios y la ejecución pueden impedir salir al valor previsto.

## Primer bloque de trabajo recomendado

Implementar A y la parte de deadlines de B en un cambio acotado: validación estricta de configuración, live explícito, no fondeo implícito, rechazo de decisiones vencidas y sus pruebas. Después abordar persistencia/reconciliación. No comenzar cambiando de modelo, rediseñando todo el frontend ni agregando infraestructura distribuida.

## Continuidad y presupuesto de uso

La captura del usuario mostraba 54% restante en ventana de 5 h y 51% semanal. Se usó como referencia, no como medición actual ni conversión a tokens disponibles. El análisis se mantuvo en una sola sesión sin agentes paralelos ni instalaciones de dependencias. No se puede deducir de esos porcentajes cuánto consumió este trabajo.

Para retomar, leer `RETOMAR.md`. Este informe, el diagnóstico reproducible y el punto de retomada están guardados en el repo; no dependen de que se conserve el historial del chat.
