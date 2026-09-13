declare module 'branch:assets' {
  const assets: Record<string, { contentType: string; base64: string }>;
  export default assets;
}
