"""Converts AllenAI ToyBlocks' AlphabetBlockLarge USD library into a small web bundle.

Every glyph block shares one body mesh and one decal mesh; only the decal's UVs pick the
glyph out of the atlas. So the bundle is: the two meshes once, the decal UVs per glyph,
and the three textures resized for the web.

  usage: python video/toyblocks_convert.py <train_blocks_large/usd/VERSION dir> <out dir>

ToyBlocks is Apache-2.0 (https://github.com/allenai/ToyBlocks); the assets come from its
public resources bucket via `get-toyblocks-assets`.
"""
import json
import sys
from pathlib import Path

from PIL import Image
from pxr import Usd, UsdGeom

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)


def mesh_data(prim, with_uv=True):
    m = UsdGeom.Mesh(prim)
    xf = UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(Usd.TimeCode.Default())
    pts = [xf.Transform(p) for p in m.GetPointsAttr().Get()]
    counts, idx = list(m.GetFaceVertexCountsAttr().Get()), list(m.GetFaceVertexIndicesAttr().Get())
    st = UsdGeom.PrimvarsAPI(prim).GetPrimvar('st') if with_uv else None
    uv = list(st.Get()) if st else []
    uv_interp = st.GetInterpolation() if st else None
    uv_idx = list(st.GetIndices()) if st and st.IsIndexed() else None
    # triangulate fans; flatten to per-corner arrays (face-varying UVs need it)
    P, UV = [], []
    k = 0
    for c in counts:
        corners = list(range(k, k + c))
        for i in range(1, c - 1):
            for corner in (corners[0], corners[i], corners[i + 1]):
                v = idx[corner]
                P.append([round(x, 6) for x in pts[v]])
                if uv:
                    j = corner if uv_interp == 'faceVarying' else v
                    if uv_idx is not None: j = uv_idx[j]
                    UV.append([round(uv[j][0], 6), round(uv[j][1], 6)])
        k += c
    return P, UV


_stages = []   # keep stages alive while their prims are read


def meshes(path):
    stage = Usd.Stage.Open(str(path))
    _stages.append(stage)
    found = {}
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.Mesh):
            mat = prim.GetRelationship('material:binding').GetTargets()
            name = str(mat[0]) if mat else prim.GetName()
            found['decal' if 'Decal' in name else 'body'] = prim
    return found


glyphs = sorted(p.stem for p in src.glob('*.usda') if p.stem != 'scene')
first = meshes(src / f'{glyphs[0]}.usda')
body_p, body_uv = mesh_data(first['body'])
decal_p, _ = mesh_data(first['decal'])
uvs = {g: mesh_data(meshes(src / f'{g}.usda')['decal'])[1] for g in glyphs}
lo = [min(p[i] for p in body_p) for i in range(3)]
hi = [max(p[i] for p in body_p) for i in range(3)]
json.dump({
    'source': 'allenai/ToyBlocks AlphabetBlockLarge (Apache-2.0)',
    'units': 'metres, z up', 'extent': [round(h - l, 5) for l, h in zip(lo, hi)], 'centre': [round((h + l) / 2, 5) for l, h in zip(lo, hi)],
    'body': {'position': body_p, 'uv': body_uv},
    'decal': {'position': decal_p},
    'glyphUV': uvs,
}, open(out / 'blocks.json', 'w'), separators=(',', ':'))

tex = src / 'Textures'
Image.open(tex / 'alphabet_block_large_base_albedotransparency.png').convert('RGB').resize((1024, 1024), Image.LANCZOS).save(out / 'body.jpg', quality=88)
Image.open(tex / 'alphabet_block_large_base_normal.png').convert('RGB').resize((512, 512), Image.LANCZOS).save(out / 'body_normal.png')
d = Image.open(tex / 'alphabet_block_large_decals_albedotransparency.png').convert('RGBA')
d.resize((2048, 2048), Image.LANCZOS).save(out / 'decals.webp', quality=90)
print('glyphs', glyphs, 'extent', [h - l for l, h in zip(lo, hi)], 'body tris', len(body_p) // 3, 'decal tris', len(decal_p) // 3)
