# Table Generator

**Live:** https://pham-tuan-binh.github.io/table-generator/

Enter a few sizes and get a robot test table made of aluminium extrusion: a table with a box frame on top for the arm and cameras, a shelf and bracing below, and feet or casters underneath. The same parameters produce the sim assets for the virtual table and the build plan for the real one.

The look and the box-on-a-table layout come from [SO-Frame](https://github.com/livekit-examples/so-frame). The 3D view follows [blueprint](https://github.com/pham-tuan-binh/blueprint): an orthographic technical drawing with yellow for the parts new in a step and red for the part you click.

## What you get

| Output | Contents |
|---|---|
| **MuJoCo** `mjcf/scene.xml` | Static frame body with T-slot profile visual meshes, box colliders, and renderable cameras with `fovy` and `resolution` |
| **URDF** `urdf/frame.urdf` | `base_link` with mass and inertia, a `worktop_frame` to mount a robot on, `<name>_camera_link` and `<name>_camera_optical_frame` per camera, and Gazebo camera sensors |
| **OpenUSD** `usd/frame.usda` | z up, metres, PBR materials, `PhysicsCollisionAPI` colliders, `Camera` prims (Isaac Sim, usdview) |
| **glTF** `frame.glb` | Colours and glTF cameras (Blender, three.js) |
| `cameras.json` | Intrinsics K and the pose of each camera in ROS, OpenCV and OpenGL conventions |
| `bom.csv`, `cutlist.csv` | Bill of materials: extrusion, brackets, screws, T-nuts, feet or casters, panels, cameras. Optional nesting into stock lengths |
| `panels/*.dxf` | Panel outlines for CNC or laser cutting |
| `README.md` | Checks, BOM, cut list, cameras and step-by-step build plan |

## Parameters

- **Size:** width, depth, table height, box height, and the profile (2020, 3030, 4040 or 1010).
- **Below the worktop:** storage shelf, lower reinforcement rails (all four sides, sides and back, or none), and supports under the worktop.
- **Base:** levelling feet, or braked casters (Ø50 to Ø100).
- **Box:** wall panels on any side plus a roof, and an overhead camera bar.
- **Panels:** materials (HPL, ACM, acrylic, polycarbonate, plywood, MDF, HDPE, aluminium) and thicknesses. The wall thickness is checked against the profile's slot width.
- **Colours:** extrusion, walls, worktop and shelf, and wall opacity.
- **Cameras:** as many as you like. Pick a preset or set your own resolution and FOV. Mount a camera on any rail or post with *Place on frame* (click a member in the 3D view), slide it along the member, and aim it at a point or by yaw/pitch/roll. The inset in the 3D view shows what that camera sees.

The design lives in the URL, so a link is the design. You can also save `params.json` from a download and load it again later.

## Frame conventions

The origin is on the floor under the centre of the table. z points up, x runs across the width from left to right, and y runs from the front to the back. Units are metres in the sim files and millimetres everywhere else. Camera targets are given relative to the centre of the worktop surface.

## Develop

```bash
npm install
npm run dev                                  # web app at localhost:5173
npm run build                                # static site in dist/
npm run generate -- params.json out/         # same files as the web download, from the command line
```

Pushing to `main` builds the site and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

## Layout

```
src/params.ts      inputs, limits, materials, profiles, camera presets, URL hash
src/model.ts       params -> parts (members, panels, hardware, cameras), mass/inertia, build steps
src/bom.ts         BOM, cut list, stock nesting, design checks
src/geometry.ts    three.js geometry (T-slot profile, boxes, cylinders)
src/viewer.ts      technical-drawing 3D view, camera inset, click-to-place
src/drawings.ts    dimensioned top/front/side SVG
src/export/        urdf, mjcf, usd (+stl), glb, bundle (zip tree, DXF, cameras.json, README)
scripts/generate.ts  command-line generator
```
