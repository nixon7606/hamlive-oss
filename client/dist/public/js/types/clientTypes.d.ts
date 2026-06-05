export type DefaultStateTypes = boolean | null;
type SimpleInteractionMethod<K, IsStateRequired extends boolean, T = DefaultStateTypes> = IsStateRequired extends true ? (callSign: string, state: T) => K : (callSign: string, state?: T) => K;
export interface SimpleInteractions<K, IsStateRequired extends boolean = false, T = DefaultStateTypes> {
    hand: SimpleInteractionMethod<K, IsStateRequired, T>;
    highlight: SimpleInteractionMethod<K, IsStateRequired, T>;
    checkState: SimpleInteractionMethod<K, IsStateRequired, T>;
}
export type SimpleInteractionMethodNames = keyof SimpleInteractions<unknown>;
export {};
//# sourceMappingURL=clientTypes.d.ts.map