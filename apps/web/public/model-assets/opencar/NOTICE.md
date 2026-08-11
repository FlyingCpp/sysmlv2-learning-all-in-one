# OpenCar vehicle asset notice

## Upstream work

- Asset: `Car Concept`
- Upstream repository: <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept>
- Pinned source revision: `2bac6f8c57bf471df0d2a1e8a8ec023c7801dddf`
- Downloaded artifact: `glTF-Binary/CarConcept.glb`
- Upstream artifact SHA-256: `c272098089d78c5cd9fd9f24ff50ee8acf8d932c55f2d55fc10adb6c8998966b`
- Adapted runtime artifact SHA-256: `9e7a6dca8a171d86f88fa9e24c305665eea2fc32c80b4cd1427d129147b20c60`
- Adapted runtime artifact size: `8,850,676` bytes

`Car Concept` is Copyright 2024 Darmstadt Graphics Group GmbH. Model and textures by Eric Chadwick. It is licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

The upstream asset contains Khronos and 3D Commerce marks. Those marks are governed by the [upstream asset license and trademark notice](https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/CarConcept/LICENSE.md). This application hides the `License Plate` and `InteriorSteeringEmblem` nodes that carry those marks and does not claim endorsement by Khronos Group or 3D Commerce.

## Adaptations in this project

The OpenCar BoardNet Lab removes 14 embedded texture images because its engineering view replaces the source appearance with transparent runtime materials. It also applies a coordinate transform, component overlays, cable-routing overlays, and the logo-node suppression described above. Source geometry and logical node names are preserved. The deterministic adaptation script is `scripts/prepare-opencar-vehicle-asset.js`. The adapted display remains licensed under CC BY 4.0.
