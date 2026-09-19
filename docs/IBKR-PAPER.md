# IBKR: primera conexión de sólo lectura

El objetivo del proyecto es operar en EE. UU. y Europa con IBKR: acciones, ETFs, bonos, opciones y futuros. Esta primera entrega **sólo descarga una fotografía de una cuenta Paper**. No decide, envía ni cancela órdenes, ni transfiere fondos. La selección de activos y el capital autorizado se definirán después. Los ETFs actuales no están autorizados para operar.

## Qué está implementado

- Programa TypeScript que inicia un lector pequeño en Python, usando el SDK oficial de IBKR.
- Conexión únicamente a `127.0.0.1`, puertos Paper habituales `4002` (Gateway) o `7497` (TWS), cliente no cero.
- Cuenta explícita `DU...` o `DUT...`, cotejada contra las cuentas de la sesión antes de suscribirse. No selecciona automáticamente la primera cuenta ni todas las cuentas.
- Consulta de valores de cuenta por divisa y posiciones por contrato. Guarda cantidades como texto decimal; no convierte nominales de bonos o contratos de derivados en acciones. Los ETFs suelen aparecer como STK: esa etiqueta no identifica por sí sola un ETF.
- Espera handshake y accountDownloadEnd. Error, desconexión, timeout, AccountReady=false o descarga vacía rechazan la respuesta en vez de mostrar saldo cero. AccountReady ausente se representa como null, no como true.
- Salida JSON por consola; sin servidor HTTP, sin historial en disco ni envío al modelo. Conservá esa salida como información privada.

Los prefijos DU/DUT y el puerto son comprobaciones conservadoras, **no una certificación criptográfica del modo Paper**. Los puertos son configurables en IBKR. La protección principal de este lector es que sólo invoca solicitudes de lectura. readOnly=true describe al lector, no demuestra que la configuración de IBKR esté en sólo lectura. Tampoco se certifica aún que la cuenta sea Cash: AccountType puede describir la titularidad, no el régimen de margen.

## Preparación en IBKR

1. Abrí TWS o IB Gateway e iniciá sesión con tu cuenta **Paper Trading**, no con la real. Las credenciales se ingresan únicamente en IBKR.
2. En los ajustes API, mantené **Read-Only API activado**. En TWS habilitá conexiones socket. Permití únicamente conexiones locales.
3. Verificá el puerto y el identificador de la cuenta Paper. El puerto sólo es una convención; verificá el modo en la pantalla de IBKR.
4. No hace falta cambiar permisos de instrumentos, mover tus ETFs ni fondear para probar este lector sobre una cuenta Paper ya disponible.

## SDK y entorno

No hay SDK oficial TWS para TypeScript. El puente usa **Python 3.13 + IBKR API 10.50.2**, verificado con sus callbacks. Descargá el paquete Mac/Unix correspondiente desde [IBKR API Software](https://interactivebrokers.github.io/), con un Gateway/TWS compatible. No instalar un paquete ibapi arbitrario de PyPI: IBKR distribuye su SDK oficial por su descarga propia.

Tras descomprimir el archivo oficial, instalalo en un entorno separado (reemplazá la ruta de descarga):

```sh
python3 -m venv .venv-ibkr
.venv-ibkr/bin/python -m pip install /ruta/IBJts/source/pythonclient
```

La dependencia del SDK probado es `protobuf==5.29.5`. No se agregaron dependencias npm. El archivo descargado durante desarrollo fue `twsapi_macunix.1050.02.zip`, SHA256 `673129e5cba58c4d77bc40647265f84ea42f605eccf88fa4c1221d62d12454f3`. No redistribuimos el SDK en el repo.

Para ejecutar, reemplazá DU1234567 por la cuenta Paper exacta:

```sh
IBKR_PAPER_ACCOUNT=DU1234567 IBKR_PAPER_PORT=4002 IBKR_PYTHON="$PWD/.venv-ibkr/bin/python" bun run ibkr:inspect
```

Este comando no carga `.env`, no importa la configuración cripto y no pasa claves del modelo o wallet al proceso Python. `IBKR_CLIENT_ID` por defecto es 71; elegí otro positivo si ya está ocupado. `IBKR_TIMEOUT_SECONDS` por defecto es 15, máximo 60. Si la descarga supera el límite de salida de 2 MiB, se rechaza completa.

**`bun run start` sigue siendo la aplicación Kuru anterior**, no la integración IBKR. Para esta etapa usá exclusivamente `ibkr:inspect`. No hay pantalla IBKR todavía.

## Validación y límites

- `bun run test`: incluye pruebas de configuración, identidad y formato del lector TypeScript además de las pruebas anteriores.
- `bun run test:ibkr`: 9 pruebas Python aisladas, sin SDK ni conexión, de callbacks, cuentas ajenas, descarga incompleta, valores inválidos y tipos de contrato.
- También se verificó la herencia/callbacks con el SDK oficial instalado temporalmente en `/private/tmp/jev-ibkr-venv`. Esa carpeta puede desaparecer; no es una instalación global.
- No se hizo una conexión autenticada, ni se consultaron datos reales de la cuenta del usuario. Falta validar la descarga completa con una sesión Paper abierta.
- No consulta permisos de trading, órdenes abiertas, catálogo de contratos, cotizaciones históricas ni suscripciones de mercado. Eso sigue en la próxima etapa. Las posiciones recibidas contienen datos de los contratos ya mantenidos; no constituyen un catálogo.
- Los valores se muestran según IBKR, sin convertirlos ni atribuirlos al bot. No usar NetLiquidation/BuyingPower como sus USD 100 autorizados. No se implementó todavía un presupuesto IBKR ni un límite de pérdidas.

## Referencias oficiales

- [Lenguajes oficiales y TWS API](https://www.interactivebrokers.com/docs/tws-api/doc/introduction).
- [Configuración API, Paper y sólo lectura](https://www.interactivebrokers.com/campus/trading-lessons/installing-configuring-tws-for-the-api/).
- [Descarga oficial del SDK](https://www.interactivebrokers.com/docs/tws-api/doc/download-the-tws-api/introduction).
- [Callbacks de cuenta y fin de descarga](https://www.interactivebrokers.com/docs/tws-api/doc/account-portfolio-data/account-updates/receiving-account-updates).
