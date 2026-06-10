{
  "name": "{{PACKAGE_NAME}}",
  "version": "{{PACKAGE_VERSION}}",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/firmislabs/{{PACKAGE_SLUG}}.git"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20"
  }{{PACKAGE_BIN}}
}
