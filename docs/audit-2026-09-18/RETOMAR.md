# Punto de retomada — Jev Trader

## Cambio de alcance: IBKR — primera implementación 19/09/2026

El usuario definió IBKR, cuenta Cash, residencia fiscal España, EE. UU. + Europa, acciones/ETFs/bonos/opciones/futuros. Ya tiene ETFs que no quiere tocar y USD 100 inicialmente libres; pidió dejar la configuración de qué operar y límites para el final. Autorizó continuar la adaptación por Paper. No hay permiso para operar sus ETFs, abrir posiciones reales ni mover fondos. No volver a enfocar nuevos incrementos en gas/Kuru.

Los seis incrementos anteriores están ahora en commit `93df338` (usuario: “primeras mejoras en jev trader | sin IB aun”). Partimos de árbol limpio. Esta entrega IBKR queda local, sin commit.

Implementado `src/ibkr/inspect.ts` + `reader.py`: lector de cuenta Paper sólo local, cuenta DU explícita en sesión, descarga completa de valores/posiciones por reqAccountUpdates. Espera handshake + accountDownloadEnd, rechaza errores/desconexión/not-ready/vacío. Sin modelos, órdenes, cancelaciones, transferencias, servidor ni persistencia de cartera. Contratos multiinstrumento y divisas preservados, decimales como texto. DU/puertos son guardas, no prueba absoluta de Paper; readOnly describe capacidad del lector, no ajuste verificado de TWS.

SDK oficial descargado desde IBKR, API 10.50.2 y protobuf 5.29.5 instalados sólo en `/private/tmp/jev-ibkr-venv`. Prueba de callbacks sobre SDK real pasó sin conexión. Guía completa/versiones/checksum/comandos en `docs/IBKR-PAPER.md`.

Validación actual: 106 pruebas Bun (407 aserciones) + 8 pruebas Python pasan; typecheck correcto. No hubo conexión IBKR autenticada: falta sesión Paper abierta e identificador de cuenta configurado por el usuario. No acceder a credenciales ni intentar conectar por inferencia a una sesión real. `ibkr:inspect` no carga .env ni config cripto. `start` sigue siendo Kuru; guía lo advierte.

Siguiente: verificar lectura con Paper cuando esté disponible; agregar consulta de contratos y órdenes abiertas, después interfaz común IBKR de ejecución simulada y riesgo. Sin límite de pérdidas/equity IBKR todavía, sin asignar los ETFs o saldo total al bot. Clasificación Cash y permisos no verificados por el lector. No inferir ETF sólo desde secType=STK. Límites económicos y activos autorizados se cierran antes de cualquier habilitación real.

Prompt actualizado: “Continuá la migración de Jev Trader a IBKR Paper. Leé RETOMAR.md y docs/IBKR-PAPER.md. El lector de sólo lectura está implementado y probado sin conexión autenticada. Preservá Kuru como legado y los cambios locales. Seguí con la integración IBKR multiinstrumento, sin tocar ETFs existentes, transferir fondos ni habilitar operaciones reales. Los límites/asignaciones se definen al final.”

---

## Pedido y estado actual

El usuario pidió análisis y plan de seguridad, usabilidad, calidad y trading; luego confirmó autonomía y autorizó empezar la implementación y continuar. Operación normal sin aprobación humana por orden, siempre dentro de límites previos. No habilitar fondos reales ni desplegar por inferencia.

Base de auditoría: `236c99e32a9998d9e88cf70f78d49628eadc212c`.
Informe histórico y plan: `ANALISIS-Y-PLAN.md` en esta carpeta.
**Sexto incremento implementado; A y B aún parciales.** Cambios locales sin commit. No se modificó el frontend ni se operó on-chain.

## Implementado

- `src/config.ts`: `loadConfig` comprobable, simulación por defecto aunque exista clave; live exige DRY_RUN=false literal y clave válida. Validación numérica, límites relativos, enumeraciones, URLs y direcciones. Errores sin imprimir valores sensibles. Modelo Jev exige API key.
- `src/market.ts`: arranque sin depósitos ni approvals; eliminación del fondeo implícito. Chequeo explícito de chainId de ambos RPC, MON nativo, precisión/tamaño del mercado y verifiedMarket en live. No son una auditoría de contratos ni validación completa del token quote.
- `src/deadline.ts`, trader/model/book: deadline por bloque, propagación de abort a lectura/modelo, descarte de respuestas tardías, verificación posterior a firma. No se cancela un broadcast por cambio de bloque. Bloques omitidos mientras hay operación se emiten después, en orden. Duplicados ignorados.
- `src/chain.ts`: errores HTTP/respuestas sin result explícitos y timeout RPC.
- Market calcula hash y reserva nonce antes de transmitir. Si se pierde respuesta, mantiene estado `lost` (= incierto) y sigue consultando. No reutiliza nonce por error. Polls superpuestos no liquidan dos veces; receipts inválidos no liberan reservas. El registro SQLite ahora protege reinicios; ver segundo incremento abajo.
- Trader conserva exposición de `lost`; bloquea ambos lados cuando Market tiene incertidumbre. Si finalmente llega un receipt válido, se resuelve. Si una tx fue descartada definitivamente, puede quedar pausado hasta futura reconciliación; no se adivina que es seguro seguir.
- `src/trades.ts`: catch-up limitado a 1.000 bloques por poll desde el cursor antiguo; ya no saltea bloques contables.
- Comandos test/typecheck en package.json; pruebas incluidas en tsconfig. README y .env.example actualizados. MARGIN_MON/MARGIN_USDC ya no se usan.
- `src/index.ts`: ya no imprime la URL RPC que podría contener credenciales.

## Segundo incremento: persistencia y recuperación

- `src/journal.ts`: SQLite incorporado en Bun, sin dependencias nuevas. WAL, synchronous=FULL y bloqueo EXCLUSIVE durante la vida del proceso. Identidad wallet/mercado/margin/chain, checksum y validación de secuencia; duplicados idénticos son idempotentes, conflictos bloquean. El bloqueo se libera al morir el proceso; probado con SIGKILL.
- `STATE_PATH=data/live.sqlite`: intención/hash/nonce comprometidos antes de transmitir. Receipts y lotes de fills comprometidos antes de aplicar efectos o avanzar cursor. Fallos de disco bloquean decisiones y envíos. No guarda claves ni transacciones firmadas.
- Market restaura pendientes y consulta nonces latest/pending. Journal vacío sólo acepta signer nuevo con ambos nonces cero; una wallet usada requiere importación/reconciliación todavía no implementada. Actividad externa de nonce incompatible bloquea arranque.
- Trader restaura inventario relativo de trading, exposición, gas confirmado y uso del modelo. Antes de reanudar alcanza el cursor actual, resuelve pendientes y verifica órdenes conocidas y balances de margin al mismo bloque. Recién decide en un bloque nuevo posterior a recuperación exitosa.
- Fills identificados por hash/logIndex; saldos parciales y cancelaciones sobreviven a receipts tardíos, sin resucitar órdenes. Cursor explícito cero incluye los primeros fills. La contabilidad conserva cada fill; la UI conserva el agregado anterior por bloque.
- Snapshot HTTP/SSE inicial incluye health, reason y cursor. Aún falta mostrarlo en frontend. Script dry-encode usa Market offline y no abre journal.
- Pruebas nuevas: caída forzada, bloqueo de segundo escritor, corrupción/huecos, fallo real de escritura antes del broadcast, reinicio con envío incierto, fill-before-receipt, cancel-before-placement, catch-up durable y reanudación sólo con verificación exitosa.

Limitaciones: volumen local persistente obligatorio, no coordinación distribuida. No borrar DB/WAL para desbloquear ni copiar DB en ejecución sin backup SQLite apropiado. No hay importador, compactación ni manejo de reorganizaciones de cadena. Verifica órdenes conocidas, no descubre toda actividad previa. Un intento persistido cuyo envío nunca empezó por deadline puede mantener pausa conservadora, igual que una tx descartada; falta política de reemplazo. Costos del modelo se reconstruyen con el precio configurado; no es equity completo.

## Tercer incremento: cancelación independiente

- `Market.cancelOrders`: calldata `batchCancelOrders` del ABI/SDK instalado; cero nuevas órdenes y cero value. Mismo journal/hash/nonce/receipt que colocaciones; exclusión durante firma/envío para no compartir nonce. Espera transacciones anteriores y bloquea colocaciones mientras la cancelación está pendiente.
- `Quote.kind` opcional: ausente significa quote histórico, `cancel` representa cancelación con size/price cero (side legado ignorado). Receipt exitoso `canceled`, sin OrderCreated, exige logs de cancelación para todos los IDs pedidos. No libera órdenes por mero envío, timeout o receipt incompleto. Revert conserva órdenes y contabiliza gas.
- Trader persiste `protection` ante error/vencimiento de lectura/modelo, hold explícito o ningún lado permitido si hay órdenes/exposición pendiente. No vuelve a consultar modelo/libro durante protección. Espera transacciones previas y cursor actualizado, después cancela sin reemplazar. Al quedar sin órdenes/pendientes, limpia protección y sólo otro bloque fresco permite decidir.
- Revert de cancelación restaura `cancellation_failed` desde receipt al reiniciar: pausa sin reintentos ilimitados. Falta un procedimiento seguro de resolución/reanudación para ese caso. No borrar historial para destrabar.
- Corregido hold que antes se convertía en buy. Simulación borra órdenes simuladas sin firmar. Consola distingue cancelación de colocación. Frontend aún no adapta la presentación de cancel-only; API/SSE incluyen tipo/estado y health.
- Pruebas cubren calldata y persistencia previa, IDs inválidos, disco fallando, firma concurrente, receipt incompleto, tx incierta/revert/reinicio, falla del modelo/libro, margen insuficiente, hold, exposición retenida y reanudación posterior.

Alcance: necesita proceso/feed/RPC/firma/almacenamiento/gas disponibles. Espera pendientes inciertos y no cancela si el cursor no está al día. No hay cancelación al apagar, watchdog externo, reserva de gas, liquidación ni presupuestos. Usa gas limit configurado del mercado; un límite insuficiente puede revertir y pausar. No habilitar live autónomo todavía.

## Cuarto incremento: presupuesto conservador de gas — 19/09/2026

- `src/gas-budget.ts`: asignación acumulada en wei, por hash, reconstruida desde intents. Usa costo máximo gasLimit × maxFeePerGas, sin liberar presupuesto con receipts/reverts ni reinicios. No es el gas realmente gastado.
- Config `GAS_BUDGET_MON` y `CANCEL_RESERVE_MON`, decimales exactos hasta 18 posiciones, cero por defecto. Reserva <= presupuesto. No se eligieron montos económicos para el usuario ni se modificó su .env.
- Market bloquea antes de firmar cuando falta política, se agota presupuesto, reserva insuficiente o historial incompleto. Nuevos intents guardan maxGasWei antes del broadcast. Cotizar debe dejar reserva suficiente para una cancelación al límite/fee actual; cancelar puede usarla sin exceder el techo total.
- Trader verifica presupuesto antes de consultar al modelo, persiste protección, cancela órdenes conocidas cuando pendientes/feed lo permiten y sigue pausado al quedar sin órdenes si no hay presupuesto. Snapshot añade límite/reserva/asignación y motivo, todos los importes en wei como strings.
- Pruebas: límites exactos, reserva consumible sólo por cancelación, duplicados/replay, configuración/precisión, pausa sin firmar, receipt barato/revert/reinicio sin restaurar capacidad y cancelación al agotarse las cotizaciones.
- Compatibilidad: intents antiguos sin maxGasWei permiten lectura/reconciliación pero bloquean nuevos envíos, incluidas cancelaciones, con gas_history_incomplete. Falta migración auditada; no borrar ni estimar historial para destrabar.

Límites: reserva contable, no dinero segregado ni lectura del saldo nativo. Un batch grande puede necesitar más gas que el límite configurado. No cubre pérdidas de trading, equity completo ni presupuesto separado de modelo. No hay reset diario: subir techo mediante configuración aumenta capacidad explícitamente, conservando toda asignación anterior. Simulación funciona con cero.

## Quinto incremento: saldo nativo para gas — 19/09/2026

- Market consulta eth_getBalance al bloque observado antes del modelo y otra vez antes de firmar, sin usar saldo cacheado para autorizar envíos. La segunda consulta corre dentro del bloqueo de envío y verifica frescura después de esperar.
- Requiere saldo para máximo gas de la tx + máximos de pendientes + reserva (cotización); cancel-only puede usar reserva. Captura pendientes antes del await para no liberar capacidad por receipts concurrentes. Una doble reserva de gas ya incluido puede causar pausa conservadora, no sobreasignación.
- Saldo inválido/consulta fallida => native_gas_unavailable; saldo insuficiente => native_gas_insufficient. No firma ni crea intent. Snapshot incluye último saldo consultado y motivo, no representa una garantía futura.
- Trader pausa sin consultar modelo y revalida durante protección. No retoma decisiones hasta otro bloque fresco tras recuperación; cancelaciones hacen su propia comprobación de fondos.
- 6 pruebas nuevas: frontera de 1 wei, respuesta malformada/red caída, gas pendiente, reserva de cancelación, decisión vencida durante consulta y reanudación sin consultas inútiles al modelo.

Costo: dos consultas RPC nuevas por ciclo live, dentro del deadline para nuevas órdenes. Puede elevar decisiones vencidas. No se midió latencia real. El saldo fijado al bloque no evita gasto externo posterior ni reorg: signer dedicado sigue requerido. Falta verificar gas suficiente para batches grandes, no sólo saldo. No se transfirieron fondos ni se habilitó live.

## Sexto incremento: cupo persistente de consultas al modelo — 19/09/2026

- `MODEL_CALL_LIMIT`: entero >= 0, cero predeterminado bloquea proveedor pago. Jev declara paid=true, mock queda exento. Adaptadores externos nuevos deben declarar paid=true.
- Trader reserva evento model_call con UUID/modelo/bloque antes de invocar proveedor. Fallos, deadlines y reinicios conservan cupo. Decisiones exitosas referencian callId; journal valida existencia y secuencia, duplicados idénticos son idempotentes.
- Agotamiento/unconfigured/historial incompleto pausa consultas antes del modelo y permite cancelaciones protectoras. No limpia pausa al quedar sin órdenes mientras el cupo siga agotado. Snapshot incluye callsAllocated/callLimit/paid/reason.
- Modelo pago sin journal bloqueado, incluso DRY_RUN actual. Mantener MODEL=mock para simulación hasta agregar journal propio de simulación. Decisiones históricas sin callId bloquean adopción del modo pago sin migración auditada (incluye historia antigua de mock).
- 9 pruebas nuevas: validación config, registro anterior a llamada, fallo proveedor/disco, timeout, reinicio, resultado idempotente, agotamiento con cancelación, historial legado y simulación sin journal.

Alcance: cupo de intentos de aplicación, no techo exacto USD/tokens ni factura total de cuenta. Puede reservar un intento sin llegar a llamar si vence tras persistir. Costos mostrados por tokens siguen estimados e incompletos para errores/respuestas tardías. Falta cuota monetaria por solicitud y reconciliación de uso proveedor. No se habilitaron llamadas pagas ni transacciones.

## Verificaciones

- 103 pruebas de backend pasaron (389 aserciones), cubriendo configuración, arranque sólo lectura, cadenas equivocadas, tamaño/precisión, vencimiento durante firma, bloque viejo, modelo/lectura colgados, envío ambiguo, receipt tardío/repetido/incorrecto, exposición retenida y catch-up sin huecos.
- Typecheck backend incluyendo tests pasó después de corregir dos errores de tipos en los dobles de prueba.
- Bundle backend pasó con Bun (se compila pero NO se ejecuta).
- No hay lint configurado. No se corrió build/UI del frontend porque no se modificó. No hubo pruebas con red/wallet real, auditoría de dependencias, backtest ni validación visual.
- No se agregaron dependencias ni se cambió bun.lock. Dependencias instaladas respetando lockfile y con scripts de instalación desactivados.
- Bun 1.3.14 instalado de forma temporal, sin cambiar la instalación global, en `/private/tmp/jev-trader-toolchain/node_modules/.bin/bun`. El directorio temporal puede desaparecer; usar Bun local disponible en ese caso.

Comandos con el runtime temporal:

```sh
/private/tmp/jev-trader-toolchain/node_modules/.bin/bun test --no-env-file --preload ./tests/setup.ts ./tests
/private/tmp/jev-trader-toolchain/node_modules/.bin/bun --no-env-file run typecheck
/private/tmp/jev-trader-toolchain/node_modules/.bin/bun build --no-env-file --target=bun ./src/index.ts --outfile /private/tmp/jev-trader-check.js
```

Con Bun en PATH, `bun run test` y `bun run typecheck`. Tests usan clave sintética, mercado/red simulados y logs temporales. `tests/setup.ts` fuerza mock/simulación y vacía credenciales. No ejecutar `bun run start` para verificar cambios: podría cargar .env del usuario.

`reproduce.cjs` se conserva como diagnóstico HISTÓRICO: ahora obtiene fuentes de la base auditada mediante `git show`. Sus aserciones documentan defectos originales, no verifican la versión corregida. La suite actual es `tests/`.

## Pendientes críticos / siguiente incremento

1. Límite persistente de pérdidas y costos completos/equity. Cupo del modelo implementado por intentos; falta reconciliación monetaria del proveedor y journal separado para simulación paga. Gas, reserva contable y saldo nativo implementados; falta comprobar suficiencia de gas para batches de cancelación. Capital/límites económicos siguen pendientes del usuario. No usar P&L actual como equity completo.
2. Completar cancelación: cierre ordenado/watchdog, política de resolución de revert y pausa visible. No liquidar todo el inventario sin definir política.
3. Completar reconciliación: importador para wallet usada, descubrimiento de órdenes, finalidad/reorg, resolución de tx descartadas y almacenamiento acotado/checkpoints sin perder contabilidad.
4. Costos reales vs estimados y contabilidad de equity; model prompt aún dice IOC aunque se opera maker; hold y validación de salida necesitan tratamiento explícito.
5. UI: mostrar health/frescura, decisión vs ejecución, costos y accesibilidad. Leer web/AGENTS.md y documentación de Next antes de modificarla.
6. CI/lint, protección SSE, rotación de logs, simulación conservadora y evaluación fuera de muestra.

No presentar estos cambios como sistema ya seguro o rentable. Los límites de pérdida futuros serán disparadores de protección, no garantías de ejecución/precio.

## Cómo continuar

Revisar git status/diff antes de editar; preservar todos los cambios actuales. Seguir por contabilidad completa/límite de pérdidas, siguiendo patrones simples del repo. No hace falta repetir la auditoría. Actualizar este archivo con cada incremento.

Captura de usage original: 54% ventana 5 h / 51% semanal. En el tercer incremento el usuario informó 20% restante de la ventana de 5 h; no equivale a saldo verificado actual. Sin agentes paralelos. Trabajar en bloques verificables y preservar contexto acá.

Prompt para una nueva sesión:

“Continuá las mejoras autorizadas de Jev Trader. Leé docs/audit-2026-09-18/RETOMAR.md y revisá el diff. Los seis primeros incrementos están implementados, con 103 pruebas; seguí con contabilidad completa/límite de pérdidas. Mantener autonomía dentro de límites, sin habilitar dinero real, fondear, enviar transacciones ni desplegar. Preservá los cambios y actualizá el punto de retomada.”
