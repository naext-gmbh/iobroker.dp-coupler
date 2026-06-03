declare global {
    namespace ioBroker {
        interface AdapterConfig {
            mappingsRaw: string;
            forwardOnAckDefault: boolean;
            forwardChangesOnlyDefault: boolean;
            propagateAckDefault: boolean;
            syncIntervalValue: number;
            syncUnit: string;
            relayOnChange: boolean;
            enabledDefault: boolean;
        }
    }
}
export {};
//# sourceMappingURL=main.d.ts.map