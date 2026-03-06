declare module "*.wasm" {
    const value: WebAssembly.Module;
    export default value;
}

declare module "LINALG_WASM" {
    const value: WebAssembly.Module;
    export default value;
}

declare module 'wrangler-wasm:*.wasm' {
    const value: WebAssembly.Module;
    export default value;
}
