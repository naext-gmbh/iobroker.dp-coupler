# ioBroker dp-coupler Adapter

Relays state changes between arbitrary ioBroker datapoints via a JSON mapping
configuration. When a source datapoint changes, the adapter writes the new
value to the configured target datapoint.

## Status

**Field-test ready.** Unidirectional and bidirectional relay, ACK filter,
change-only filter, and periodic sync are implemented. See Roadmap for remaining items.

## Installation

```bash
iobroker url https://github.com/johannes-lode/iobroker.dp-coupler
```

Then create an instance in the admin UI and configure the mappings.

To update an existing installation, run the same command again. Instance
configuration is preserved (stored in the ioBroker database, not in the
adapter directory).

## How it works

The adapter reads a list of source→target mappings from its instance
configuration (`mappingsRaw`). On startup it subscribes to all source
datapoints (and, for bidirectional entries, their targets too). Whenever a
subscribed state changes, the value is written to the corresponding destination
with `ack: false` (command semantics).

Two filters and one propagation flag control relay behaviour:

- **forwardOnAck** — whether states with `ack: true` (device confirmations)
  trigger a relay. Default `false`: only commands (`ack: false`) are forwarded.
- **forwardChangesOnly** — whether re-writes of the same value are suppressed.
  Default `true`: only actual value changes are relayed.
- **propagateAck** — whether the target write receives `ack: true` when the
  source had `ack: true`. Default `false`: target always receives `ack: false`
  (command semantics).

All three have adapter-level defaults (configurable in the **Defaults** tab)
and can be overridden per mapping entry.

A cycle guard (`inFlight` set) prevents bidirectional relay loops: states
written by dp-coupler itself are never relayed back.

The `info.connection` state is `true` while at least one mapping is loaded and
subscriptions are active.

On every successful start the current configuration is also written to
`mappings.json` in the adapter's install directory as a convenience export
(backup, deployment template).

## Configuration

### Mapping tab

Enter a JSON array of mapping objects in the **Mapping** tab:

```json
[
  {
    "_comment": "Modbus reading → setpoint; ack=true because Modbus adapter confirms values",
    "source": "modbus.0.holdingRegisters.8",
    "target": "0_userdata.0.battery.powerSetpoint",
    "forwardOnAck": true,
    "propagateAck": true
  },
  {
    "_comment": "Bidirectional setpoint relay; uses adapter defaults for filters",
    "source": "0_userdata.0.setpoint",
    "target": "modbus.0.holdingRegisters.12",
    "bidirectional": true
  },
  {
    "_comment": "Simple relay; all filters from adapter defaults",
    "source": "hm-rpc.0.ABC123.1.TEMPERATURE",
    "target": "0_userdata.0.temp_display"
  }
]
```

| Field               | Required | Default          | Description                                                           |
|---------------------|----------|------------------|-----------------------------------------------------------------------|
| `source`            | yes      | —                | Full ioBroker state ID to subscribe to                                |
| `target`            | yes      | —                | Full ioBroker state ID to write to                                    |
| `bidirectional`     | no       | `false`          | Also subscribes to `target` and relays changes back to `source`       |
| `forwardOnAck`      | no       | adapter default  | Override: trigger relay when source has `ack: true`                   |
| `forwardChangesOnly`| no       | adapter default  | Override: relay only if `val` actually changed (suppress re-writes)   |
| `propagateAck`      | no       | adapter default  | Override: write target with `ack: true` when source had `ack: true`   |

Unknown keys (e.g. `_comment`) are silently ignored.

**Note for bidirectional entries:** `forwardOnAck`, `forwardChangesOnly`, and
`propagateAck` apply to both relay directions of the same entry.
Per-direction overrides are not currently supported.

### Defaults tab

Sets the adapter-wide defaults used by entries that do not specify their own
value.

| Setting                     | Default | Description                                                   |
|-----------------------------|---------|---------------------------------------------------------------|
| Forward on ACK               | off     | Trigger relay when source has `ack: true`. Enable for polling sources such as Modbus. |
| Forward value changes only   | on      | Suppress re-writes where `val` did not change (polling refreshes). |
| Propagate ACK flag to target | off     | Write target with `ack: true` when source had `ack: true`.    |
| Sync interval                | 0 (off) | Periodically re-write all target datapoints with the last known source value (heartbeat/refresh). Set a value and unit (`ms`/`s`/`min`/`h`); `0` disables the feature. |
| Relay on change              | off     | Only evaluated when sync interval > 0. `on` = event-driven relay in addition to periodic sync. `off` = periodic only (no relay on state change events). |

Save the configuration; the adapter restarts and activates the new mappings.

## Mass deployment

To deploy the same configuration across multiple ioBroker instances without
using the admin UI:

```bash
iobroker set dp-coupler.0 native.mappingsRaw "$(cat mappings.json)"
iobroker restart dp-coupler.0
```

Replace `dp-coupler.0` with the target instance identifier.

## Development

```bash
npm install
npm run build              # compile TypeScript → build/
npm run dev-server:setup   # first-time setup of the local ioBroker instance
npm run dev-server         # start dev server with watch mode
```

After changing `io-package.json` or `admin/jsonConfig.json`, restart the
dev-server. Changes to `src/main.ts` are picked up automatically.

Node.js ≥ 20 required.

`build/` is committed to the repository. Before pushing a release, run
`npm run build` and include the updated `build/` in the commit.

## Roadmap

- **Fail counter** — set `info.connection` to `false` after a configurable
  number of consecutive write failures per mapping
- **Seed from empty mapping** — when `mappingsRaw` is `[]` on startup and
  `mappings.json` exists, read the file and adopt it as the active config
- **Value conversion** — optional `transform` expression per mapping entry
  (JSON/JSONata), similar to ioBroker aliases

## License

AGPL-3.0-only — Copyright (c) Johannes Lode
