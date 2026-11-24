# Agent Instructions

- At the end of every code change, run `vpr build` so the built files are refreshed for local testing.
- Run `vp check --fix` as the validation command after code changes, before `vpr build`.
- Prefer Phosphor icons over Lucide icons for new UI. Use Lucide only when it is already the established local pattern for that specific control or when a Lucide icon is intentionally better suited, such as existing copy icons.
- To rebuild Windows or Linux assets for an existing release, use the manual `build-app.yml` workflow instead of creating a retry tag: `gh workflow run build-app.yml --ref main -f release_tag=v<version> -f platform=windows` (for example, `release_tag=v1.13.0`). `platform` accepts `windows`, `linux`, or `all`. `--ref` selects the code to build and must include the required fixes; `release_tag` selects the existing release to receive the assets and must exactly match `v` plus that ref's `package.json` version. Push fixes before dispatching. Manual runs replace matching assets for the selected platforms without creating or publishing a release. Monitor the run through completion and verify the assets are attached to the requested release.
- When you make changes to how the walkthrough works, you should consider updating the --walkthrough-guide which gives user-land agents info
