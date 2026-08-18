// Bridges the engine's canUseTool callback to the renderer's approval UI.
// Holds the pending-decision map keyed by request id, and the session-scoped
// persist cache. Cleared on every new session — a remembered "allow" must
// never outlive the window it was granted in.
export {};
