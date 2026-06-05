/* hamlive-oss — MIT License. See LICENSE. */

/*
 * Ensures consistency across InteractionClient, LiveNetReactiveStore, and
 * LiveNetElement classes. Each class should implement `hand`, `highlight`, and
 * `checkState` methods with `callsign` as the first parameter and `state` as
 * the second.
 */

export type DefaultStateTypes = boolean | null;

// Adjust the SimpleInteractionMethod type to have T default to DefaultStateTypes
// Move T to the end to comply with TypeScript's requirement that optional parameters cannot precede required ones.
type SimpleInteractionMethod<K, IsStateRequired extends boolean, T = DefaultStateTypes> = IsStateRequired extends true
    ? (callSign: string, state: T) => K // Make `state` required if IsStateRequired is true
    : (callSign: string, state?: T) => K; // Keep `state` optional if IsStateRequired is false

// Adjust the SimpleInteractions interface to have T default to DefaultStateTypes
// Also adjust the order of type parameters in SimpleInteractionMethod calls within the interface
export interface SimpleInteractions<K, IsStateRequired extends boolean = false, T = DefaultStateTypes> {
    hand: SimpleInteractionMethod<K, IsStateRequired, T>;
    highlight: SimpleInteractionMethod<K, IsStateRequired, T>;
    checkState: SimpleInteractionMethod<K, IsStateRequired, T>;
}

export type SimpleInteractionMethodNames = keyof SimpleInteractions<unknown>;
