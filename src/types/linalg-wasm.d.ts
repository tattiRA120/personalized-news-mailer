declare module "*.wasm" {
    const value: WebAssembly.Module;
    export default value;
}

declare module "linalg-wasm-bg.wasm" {
    const value: WebAssembly.Module;
    export default value;
}

declare module 'wrangler-wasm:*.wasm' {
    const value: WebAssembly.Module;
    export default value;
}
