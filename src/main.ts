// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2024 Johannes Lode

/**
 * ioBroker adapter: dp-coupler
 *
 * Relays state changes between arbitrary datapoints via a JSON mapping.
 * Configuration is stored in this.config.mappingsRaw (ioBroker DB, edited
 * via admin UI). On every successful start the config is also written to
 * mappings.json for seeding and export purposes.
 *
 * One-directional for now; bidirectional support is stubbed and can be
 * enabled per mapping entry once the reverse-subscribe logic is wired up.
 *
 * Mapping schema: Array of MappingEntry objects – see type below.
 * Unknown keys (e.g. "_comment") are silently ignored by the type guard.
 */

import * as utils from "@iobroker/adapter-core";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// ioBroker config type
// ---------------------------------------------------------------------------

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            mappingsRaw: string;
            forwardOnAckDefault: boolean;
            forwardChangesOnlyDefault: boolean;
            propagateAckDefault: boolean;
            syncIntervalValue: number; // numeric part of the sync interval; 0 = disabled
            syncUnit: string;          // unit: "ms" | "s" | "min" | "h"
            relayOnChange: boolean;    // when sync active: also relay on event; irrelevant when sync disabled
        }
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MappingEntry {
    source: string;
    target: string;
    bidirectional?: boolean;
    forwardOnAck?: boolean;
    forwardChangesOnly?: boolean;
    propagateAck?: boolean;
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isMappingEntry(value: unknown): value is MappingEntry {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    return typeof obj["source"] === "string" && typeof obj["target"] === "string";
}

// ---------------------------------------------------------------------------
// Debug trace (flip to true + rebuild to enable [dpc] output)
// ---------------------------------------------------------------------------

const DPC_DEBUG = false;
function dpcLog(...args: unknown[]): void {
    if (DPC_DEBUG) console.log(...args);
}

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

class DpCoupler extends utils.Adapter {
    private readonly sourceIndex = new Map<string, MappingEntry>();
    private readonly targetIndex = new Map<string, MappingEntry>();
    private readonly inFlight    = new Set<string>();
    private readonly lastState   = new Map<string, ioBroker.State>();
    private syncTimer: ReturnType<typeof setInterval> | null = null;
    private syncIntervalMs = 0;
    private unloading = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: "dp-coupler" });

        this.on("ready",       this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload",      this.onUnload.bind(this));
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    private async onReady(): Promise<void> {
        await this.setObjectAsync("info", {
            type: "channel",
            common: { name: "Information" },
            native: {},
        });
        await this.setObjectAsync("info.connection", {
            type: "state",
            common: {
                role: "indicator.connected",
                name: "Adapter connected and mapping loaded",
                type: "boolean",
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });

        const mappings = this.loadMappings();
        if (mappings === null) {
            // Error already logged inside loadMappings().
            return;
        }

        this.persistMappingsFile();

        if (mappings.length === 0) {
            this.log.info("dp-coupler: mapping configuration is empty – nothing to relay.");
            return;
        }

        for (const entry of mappings) {
            if (this.sourceIndex.has(entry.source)) {
                this.log.warn(
                    `dp-coupler: duplicate source "${entry.source}" in mappings – ` +
                    `only the first entry is used.`
                );
                continue;
            }
            this.sourceIndex.set(entry.source, entry);

            if (entry.bidirectional === true) {
                if (this.targetIndex.has(entry.target)) {
                    this.log.warn(
                        `dp-coupler: duplicate bidirectional target "${entry.target}" in mappings – ` +
                        `only the first entry is used.`
                    );
                } else {
                    this.targetIndex.set(entry.target, entry);
                }
            }
        }

        const subscriptions = Array.from(new Set([
            ...this.sourceIndex.keys(),
            ...this.targetIndex.keys(),
        ]));
        await this.subscribeForeignStatesAsync(subscriptions);

        for (const sourceId of this.sourceIndex.keys()) {
            try {
                const st = await this.getForeignStateAsync(sourceId);
                if (st && st.val !== null && st.val !== undefined)
                    this.lastState.set(sourceId, st);
            } catch { /* non-fatal – cache stays empty for this source */ }
        }

        const unitMultipliers: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000 };
        this.syncIntervalMs = (this.config.syncIntervalValue || 0)
            * (unitMultipliers[this.config.syncUnit ?? "ms"] ?? 1);
        if (this.syncIntervalMs > 0) {
            this.syncTimer = setInterval(this.onSyncTick.bind(this), this.syncIntervalMs);
            this.log.info(
                `dp-coupler: periodic sync active, ` +
                `${this.config.syncIntervalValue} ${this.config.syncUnit ?? "ms"} ` +
                `(${this.syncIntervalMs} ms).`
            );
        }

        const biCount = this.targetIndex.size;
        this.log.info(
            `dp-coupler: ready – relaying ${this.sourceIndex.size} datapoint(s)` +
            (biCount > 0 ? `, ${biCount} bidirectional` : ``) + `.`
        );
        await this.setStateAsync("info.connection", { val: true, ack: true });
    }

    private onUnload(callback: () => void): void {
        this.unloading = true;
        if (this.syncTimer !== null) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
        // Fire-and-forget: do not await — any async Redis op hangs when
        // js-controller tears down the connection during adapter restart.
        this.setStateAsync("info.connection", { val: false, ack: true }).catch(() => undefined);
        callback();
    }

    // -----------------------------------------------------------------------
    // State change handler
    // -----------------------------------------------------------------------

    private async onStateChange(
        id: string,
        state: ioBroker.State | null | undefined
    ): Promise<void> {
        if (!state || state.val === null || state.val === undefined) return;

        const lcTs  = state.lc === state.ts ? `lc=ts(${state.lc})` : `lc<ts(+${state.ts - state.lc}ms lc=${state.lc})`;
        const ifs   = (): string => `[${[...this.inFlight].join(",") || "∅"}]`;
        const ackCh = state.ack ? "T" : "F";
        dpcLog(`[dpc] ${id}  val=${state.val}  ack=${ackCh}  ${lcTs}  inFlight=${ifs()}`);

        // Cycle guard: skip states we ourselves just wrote.
        if (this.inFlight.has(id)) {
            this.inFlight.delete(id);
            dpcLog(`[dpc]   inFlight HIT → skip  inFlight=${ifs()}`);
            return;
        }

        // Determine relay direction and destination.
        const forwardEntry = this.sourceIndex.get(id);
        const entry        = forwardEntry ?? this.targetIndex.get(id);
        if (!entry) return;
        const destination  = forwardEntry ? entry.target : entry.source;
        dpcLog(`[dpc]   ${forwardEntry ? "fwd" : "rev"}  →  ${destination}`);

        // Update last known source state for periodic sync (forward direction only).
        if (forwardEntry) this.lastState.set(id, state);

        // Periodic-only mode: skip event relay when sync is active and relayOnChange is off.
        // Computed inline from this.config so the guard works without an adapter restart when
        // the config changes (this.syncIntervalMs is only updated in onReady()).
        const unitMultipliers: Record<string, number> = { ms: 1, s: 1000, min: 60000, h: 3600000 };
        const effectiveMs = (this.config.syncIntervalValue || 0)
            * (unitMultipliers[this.config.syncUnit ?? "ms"] ?? 1);
        if (effectiveMs > 0 && !this.config.relayOnChange) return;

        // forwardOnAck filter: default false — skip ack=true device confirmations.
        const shouldForwardOnAck = entry.forwardOnAck ?? this.config.forwardOnAckDefault ?? false;
        if (state.ack && !shouldForwardOnAck) {
            dpcLog(`[dpc]   forwardOnAck: ack=T  shouldFwd=${shouldForwardOnAck}  → FILTERED`);
            return;
        }

        // forwardChangesOnly filter: default true — skip re-writes of unchanged values.
        // state.lc (last-change) < state.ts (last-set) means value was re-written unchanged.
        const shouldForwardChangesOnly = entry.forwardChangesOnly ?? this.config.forwardChangesOnlyDefault ?? true;
        if (shouldForwardChangesOnly && state.lc !== state.ts) {
            dpcLog(`[dpc]   forwardChangesOnly: lc<ts(+${state.ts - state.lc}ms)  → FILTERED`);
            return;
        }

        this.inFlight.add(destination);
        dpcLog(`[dpc]   RELAY  inFlight=${ifs()}`);
        try {
            const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
            await this.setForeignStateAsync(destination, {
                val: state.val,
                ack: shouldPropagateAck ? state.ack : false,
                q:   state.q,
            });
            this.log.debug(`dp-coupler: ${id} → ${destination} = ${state.val}`);
        } catch (err: unknown) {
            this.inFlight.delete(destination);
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: failed to write ${destination}: ${message}`);
            // TODO: per-entry fail-counter; set info.connection = false above threshold.
        }
    }

    // -----------------------------------------------------------------------
    // Periodic sync
    // -----------------------------------------------------------------------

    private async onSyncTick(): Promise<void> {
        for (const [sourceId, entry] of this.sourceIndex) {
            if (this.unloading) break;
            const cached = this.lastState.get(sourceId);
            if (!cached) continue;
            const dest = entry.target;
            this.inFlight.add(dest);
            try {
                const shouldPropagateAck = entry.propagateAck ?? this.config.propagateAckDefault ?? false;
                await this.setForeignStateAsync(dest, {
                    val: cached.val,
                    ack: shouldPropagateAck ? cached.ack : false,
                    q:   cached.q,
                });
            } catch (err: unknown) {
                this.inFlight.delete(dest);
                const message = err instanceof Error ? err.message : String(err);
                this.log.warn(`dp-coupler: sync tick failed for ${dest}: ${message}`);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Mapping loader
    // -----------------------------------------------------------------------

    /**
     * Loads and validates the mapping configuration from this.config.mappingsRaw
     * (ioBroker DB, edited via admin UI).
     * Returns the validated array on success, or null on any unrecoverable error.
     */
    private loadMappings(): MappingEntry[] | null {
        const raw = this.config.mappingsRaw ?? "[]";

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.error(`dp-coupler: mappingsRaw is not valid JSON: ${message}`);
            return null;
        }

        if (!Array.isArray(parsed)) {
            this.log.error(`dp-coupler: mappingsRaw must be a JSON array.`);
            return null;
        }

        const valid: MappingEntry[] = [];
        for (let i = 0; i < parsed.length; i++) {
            if (isMappingEntry(parsed[i])) {
                valid.push(parsed[i] as MappingEntry);
            } else {
                this.log.warn(
                    `dp-coupler: mapping entry [${i}] is missing "source" or "target" – skipped.`
                );
            }
        }

        this.log.info(`dp-coupler: loaded ${valid.length} valid mapping(s).`);
        return valid;
    }

    /**
     * Writes the current mappingsRaw config to mappings.json as a convenience
     * export (seeding, backup, deployment template). Non-fatal on failure.
     * Skips the write when the file already contains the same content to avoid
     * triggering file-watcher restarts in dev environments.
     */
    private persistMappingsFile(): void {
        const filePath = path.resolve(this.adapterDir, "mappings.json");
        const content = this.config.mappingsRaw ?? "[]";

        try {
            const existing = fs.readFileSync(filePath, "utf-8");
            if (existing === content) return;
        } catch {
            // File absent or unreadable – proceed with write.
        }

        try {
            fs.writeFileSync(filePath, content, "utf-8");
            this.log.debug(`dp-coupler: config written to "${filePath}".`);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.warn(`dp-coupler: could not write "${filePath}": ${message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main !== module) {
    // Started as a module (e.g. from tests or dev-server): export factory.
    module.exports = (options: Partial<utils.AdapterOptions>) =>
        new DpCoupler(options);
} else {
    // Started directly via `node build/main.js`.
    (() => new DpCoupler())();
}
