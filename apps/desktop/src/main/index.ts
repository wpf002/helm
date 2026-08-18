// Entry point. Owns the BrowserWindow, wires IPC, and holds the only
// references to @helm/engine and @helm/shell. Nothing below src/renderer may
// import either package — enforced by the boundary check in scripts/.
export {};
