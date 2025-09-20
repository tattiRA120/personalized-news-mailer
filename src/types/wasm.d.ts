declare module "*.wasm?url" {
    const value: string;
    export default value;
}

declare module 'wrangler-wasm:*' {
    const value: WebAssembly.Module;
    export default value;
}
