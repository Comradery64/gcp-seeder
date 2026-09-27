# Changelog

## [0.5.0](https://github.com/Comradery64/gcp-seeder/compare/v0.4.1...v0.5.0) (2026-09-27)


### Features

* add oauth-client command to retry OAuth setup on an existing project ([c931953](https://github.com/Comradery64/gcp-seeder/commit/c93195373559715eec998d607a0c272b55f51590))
* API readiness polling + probe + retry helpers ([7191fc8](https://github.com/Comradery64/gcp-seeder/commit/7191fc8b769943482e95ebce7e0e5f62adc8f263))
* billing account list/resolve/link + billing_account in Terraform export ([1f36240](https://github.com/Comradery64/gcp-seeder/commit/1f362400361b485b677321336abf468bff357c34))
* budget alerts + kill-switch template; destroy --remove-liens and --empty ([da4c87d](https://github.com/Comradery64/gcp-seeder/commit/da4c87d7bf1ba040cdf9e06fb48fbecab7f58a44))
* explain Google errors (quota, org policy, billing, quota project, liens) ([2a57431](https://github.com/Comradery64/gcp-seeder/commit/2a57431c3f9d60a8c16ce0311e04d6eb880e2f2d))
* harden project defaults (delete default network, demote default compute SA) ([f20722f](https://github.com/Comradery64/gcp-seeder/commit/f20722f00fde547ed7b32c4b0c3f51a642a2dd50))
* least-privilege service-account role grants (roles module) ([e301cd1](https://github.com/Comradery64/gcp-seeder/commit/e301cd15dc2cd0389477eda7bc19f4d99a1253f9))
* project IAM read-modify-write primitive + v0.5 plan and orchestration docs ([100186f](https://github.com/Comradery64/gcp-seeder/commit/100186f3962d5ff9a5673ce584afde3ac67ee780))
* read-only preflight checks (auth, id, quota, parent, billing, org policy, bootstrap APIs) ([a2cbd4f](https://github.com/Comradery64/gcp-seeder/commit/a2cbd4fd92d136fbf9ebf3f5713ccebf39a6b9b2))
* render explained Google errors in the CLI and MCP server ([ac9cf2b](https://github.com/Comradery64/gcp-seeder/commit/ac9cf2babd55685c5cd4820c6e3adbc7c62aa449))
* v0.5 bootstrap hardening + oauth-client retry ([120c1dc](https://github.com/Comradery64/gcp-seeder/commit/120c1dc52500b463723412d73c76259e3cac448e))
* WIF GitLab provider + undelete soft-deleted pools/providers ([1bb2a60](https://github.com/Comradery64/gcp-seeder/commit/1bb2a601e023f627547866a2003fec996aeb3cfa))
* wire billing, readiness wait, SA roles, harden, and multi-provider WIF into seed ([d5f56ad](https://github.com/Comradery64/gcp-seeder/commit/d5f56ad1567e623886078876c30e09f918f69c8d))
* wire budget, preflight gate/command, destroy --empty/--remove-liens, and MCP params ([4b6b75b](https://github.com/Comradery64/gcp-seeder/commit/4b6b75ba5a30e8c96728be01ad08b006a124244f))


### Bug Fixes

* classify per-billing-account quota correctly, warn on it in preflight, and explain a half-provisioned project ([49bcf8c](https://github.com/Comradery64/gcp-seeder/commit/49bcf8c701d0145a5172732e1a7e185c5c32b09a))
* explain missing-org cause when OAuth brand is unavailable ([75af2e0](https://github.com/Comradery64/gcp-seeder/commit/75af2e0a28859172c994708493db882ff7575d1b))
* pick the no-brand OAuth message from the project's real parent ([058b8ec](https://github.com/Comradery64/gcp-seeder/commit/058b8ece504b3a637f036ca4997471abe13b41ad))
* validate --budget before any network call; preflight fails (not ok) when credentials are missing; export SA role bindings ([bc3b666](https://github.com/Comradery64/gcp-seeder/commit/bc3b66635c43fd4e487bb5978b8078f1795def29))

## [0.4.1](https://github.com/Comradery64/gcp-seeder/compare/v0.4.0...v0.4.1) (2026-07-12)


### Bug Fixes

* make MCP handler tests hermetic (no ambient ADC required) ([3175587](https://github.com/Comradery64/gcp-seeder/commit/3175587c29acd3dbe847c84959e4ebe36de25d76))

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
