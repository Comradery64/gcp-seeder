# Changelog

## [0.4.0](https://github.com/Comradery64/gcp-seeder/compare/v0.3.1...v0.4.0) (2026-07-12)


### Features

* --json on seed, destroy, sweep, and rotate ([115d1fc](https://github.com/Comradery64/gcp-seeder/commit/115d1fc6a8e1d906816d54822e8712d391b6f9ce))
* audit --max-key-age staleness + a rotate command ([a00e834](https://github.com/Comradery64/gcp-seeder/commit/a00e83478010e0c113e05417dae510e7764bee2f))
* declarative gcp-seeder.yaml manifest with idempotent reconcile (WS5) ([f6651d0](https://github.com/Comradery64/gcp-seeder/commit/f6651d0b076ae588a901f667695312ec771a7c4d))
* export command — render a project as Terraform (WS5) ([ac947b4](https://github.com/Comradery64/gcp-seeder/commit/ac947b44136711c2bd959d6a0215da9f44f6046e))
* keyless GitHub Actions auth via Workload Identity Federation ([ab56167](https://github.com/Comradery64/gcp-seeder/commit/ab561670561ce7525ff6700d8d0655c83dbd905a))
* MCP stdio server exposing the lifecycle as agent tools ([e43c784](https://github.com/Comradery64/gcp-seeder/commit/e43c784048dbf3dd63a08b778bab9bffbf55b1e4))
* project labels, TTL, and a sweep command for lifecycle hygiene ([a3b08d7](https://github.com/Comradery64/gcp-seeder/commit/a3b08d7082b5059ac5e39ad2182c3b84d0fe244b))


### Bug Fixes

* don't leave a half-provisioned project when WIF binding fails ([a09616f](https://github.com/Comradery64/gcp-seeder/commit/a09616ff217763da3d154a48961bd881a25910bd))
* populate labels in audit --project mode ([4393803](https://github.com/Comradery64/gcp-seeder/commit/4393803ec1e9ba352f4f30b41b75e0a106a6c28c))
* report the real package version in --version and MCP server ([147a9c3](https://github.com/Comradery64/gcp-seeder/commit/147a9c3f421f6a0e06862a7059aa29649e53e986))
* retry WIF pool/provider creation while iam.googleapis.com propagates ([50b1710](https://github.com/Comradery64/gcp-seeder/commit/50b17101b397f10ce478fb2b659c2fc3294e7a27))

## [0.3.1](https://github.com/Comradery64/gcp-seeder/compare/v0.3.0...v0.3.1) (2026-07-07)


### Bug Fixes

* warn instead of throw when SA key creation is blocked by org policy ([3e8155b](https://github.com/Comradery64/gcp-seeder/commit/3e8155b39f7597ce9ae0f2141d8148f1099f5821))

## [0.3.0](https://github.com/Comradery64/gcp-seeder/compare/v0.2.1...v0.3.0) (2026-07-07)


### Features

* multi-service-account support with domain-wide-delegation guidance ([d195e0b](https://github.com/Comradery64/gcp-seeder/commit/d195e0b929e650c2fde806c745c04f7f5fc266af))

## [0.2.1](https://github.com/Comradery64/gcp-seeder/compare/v0.2.0...v0.2.1) (2026-07-01)


### Miscellaneous Chores

* release 0.2.1 ([e4a5fee](https://github.com/Comradery64/gcp-seeder/commit/e4a5fee9a1614b8704a85a1334cf6e72e5e0d073))

## 0.2.0 (2026-07-01)


### Features

* gcp-seeder — bootstrap, audit, and tear down Google Cloud projects ([c44f8ca](https://github.com/Comradery64/gcp-seeder/commit/c44f8caf26fff7bf1ed4acc8d6f76d97481fbd39))


### Miscellaneous Chores

* release 0.2.0 ([e668aa8](https://github.com/Comradery64/gcp-seeder/commit/e668aa805078213ca10083a8492767604ca972c6))
