/// <reference types="vite/client" />

// Allow importing CSS files with the ?url suffix (used for Polaris styles)
declare module "*.css?url" {
  const src: string;
  export default src;
}