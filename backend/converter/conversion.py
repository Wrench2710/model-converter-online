"""Prepare one portable glTF scene before exporting any requested format."""
import base64
import copy
import json
import io
import mimetypes
import shutil
import struct
import subprocess
from pathlib import Path
from urllib.parse import unquote

from PIL import Image

EXPORTERS = {"glb": "glb2", "gltf": "gltf2", "obj": "obj", "stl": "stlb", "ply": "plyb", "fbx": "fbx"}


def assimp_export(source, output, target):
    result = subprocess.run(
        ["assimp", "export", str(source), str(output), f"-f{EXPORTERS[target]}"],
        capture_output=True, text=True, timeout=900,
    )
    log = (result.stdout or "") + (result.stderr or "")
    if result.returncode or not output.exists():
        raise RuntimeError(log[-4000:] or "Assimp conversion failed")
    return log


def local_resource(root, uri):
    """Never resolve a model URI outside its isolated working directory."""
    path = (root / unquote(uri).replace("\\", "/")).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        path = root / Path(unquote(uri).replace("\\", "/")).name
    if not path.is_file():
        raise RuntimeError(f"Missing linked file: {uri}. Attach the model's BIN/MTL/texture files.")
    return path


def read_uri(root, uri):
    if uri.startswith("data:"):
        header, content = uri.split(",", 1)
        return base64.b64decode(content) if ";base64" in header else unquote(content).encode()
    return local_resource(root, uri).read_bytes()


def portable_glb(document, root, output):
    document = copy.deepcopy(document)
    binary = bytearray()

    def append(data):
        binary.extend(b"\0" * (-len(binary) % 4))
        offset = len(binary)
        binary.extend(data)
        return offset

    offsets = []
    for buffer in document.get("buffers", []):
        offsets.append(append(read_uri(root, buffer["uri"])))
    for view in document.get("bufferViews", []):
        view["byteOffset"] = offsets[view.get("buffer", 0)] + view.get("byteOffset", 0)
        view["buffer"] = 0
    for image in document.get("images", []):
        uri = image.pop("uri", None)
        if uri is None:
            continue
        data = read_uri(root, uri)
        mime = uri[5:].split(";", 1)[0] if uri.startswith("data:") else mimetypes.guess_type(uri)[0]
        if mime not in ("image/png", "image/jpeg"):
            raise RuntimeError(f"Unsupported embedded texture: {uri}")
        image["mimeType"] = mime
        image["bufferView"] = len(document.setdefault("bufferViews", []))
        document["bufferViews"].append({"buffer": 0, "byteOffset": append(data), "byteLength": len(data)})
    document["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(document, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    output.write_bytes(
        struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(encoded) + 8 + len(binary))
        + struct.pack("<I4s", len(encoded), b"JSON") + encoded
        + struct.pack("<I4s", len(binary), b"BIN\0") + binary
    )


def apply_textures(document, root, assets):
    overrides = {asset.kind: asset for asset in assets if asset.kind != "resource"}
    if not overrides:
        return
    primitives = [primitive for mesh in document.get("meshes", []) for primitive in mesh["primitives"]]
    if any("TEXCOORD_0" not in primitive["attributes"] for primitive in primitives):
        raise RuntimeError("Model has no UV coordinates on one or more meshes. Add UVs before attaching textures.")
    materials = document.setdefault("materials", [])
    if not materials:
        materials.append({})
    for primitive in primitives:
        if "TEXCOORD_0" in primitive["attributes"]:
            primitive.setdefault("material", 0)
    textures = document.setdefault("textures", [])
    images = document.setdefault("images", [])
    maps = {}

    def add_texture(name, image):
        image.save(root / name, format="PNG")
        index = len(textures)
        textures.append({"source": len(images)})
        images.append({"uri": name})
        return {"index": index}

    for kind, asset in overrides.items():
        if kind in ("roughness", "metallic"):
            continue
        with Image.open(asset.file.path) as image:
            maps[kind] = add_texture(f"attached_{kind}.png", image.convert("RGBA"))
    for material_index, material in enumerate(materials):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        if "base_color" in maps:
            pbr["baseColorTexture"] = maps["base_color"]
            pbr["baseColorFactor"] = [1, 1, 1, 1]
            material.get("extensions", {}).pop("KHR_materials_unlit", None)
        if "normal" in maps:
            material["normalTexture"] = maps["normal"]
        if "ao" in maps:
            material["occlusionTexture"] = maps["ao"]
        if "emissive" in maps:
            material["emissiveTexture"] = maps["emissive"]
            material["emissiveFactor"] = [1, 1, 1]
        if "roughness" in overrides or "metallic" in overrides:
            channels = {}
            # Keep the untouched channel of an existing metallic/roughness map.
            old = pbr.get("metallicRoughnessTexture")
            if old:
                old_image = images[textures[old["index"]]["source"]]
                if "uri" in old_image and not old_image["uri"].startswith("data:"):
                    try:
                        with Image.open(local_resource(root, old_image["uri"])) as image:
                            _, channels["roughness"], channels["metallic"] = image.convert("RGB").split()
                    except RuntimeError:
                        if not all(kind in overrides for kind in ("roughness", "metallic")):
                            raise
            for kind in ("roughness", "metallic"):
                if kind in overrides:
                    with Image.open(overrides[kind].file.path) as image:
                        channels[kind] = image.convert("L")
            size = next(iter(channels.values())).size
            roughness = channels.get("roughness", Image.new("L", size, int(255 * pbr.get("roughnessFactor", 1))))
            metallic = channels.get("metallic", Image.new("L", size, int(255 * pbr.get("metallicFactor", 0))))
            packed = Image.merge("RGB", (Image.new("L", size, 255), roughness.resize(size), metallic.resize(size)))
            pbr["metallicRoughnessTexture"] = add_texture(f"attached_metallic_roughness_{material_index}.png", packed)
            pbr["roughnessFactor"], pbr["metallicFactor"] = 1, 1
        if "metallic" not in overrides and "base_color" in maps and "metallicRoughnessTexture" not in pbr:
            pbr["metallicFactor"] = 0


def prune_unused_textures(document):
    references = []

    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower().endswith("texture") and isinstance(child, dict) and "index" in child:
                    references.append(child)
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(document.get("materials", []))
    references = list({id(reference): reference for reference in references}.values())
    textures = document.get("textures", [])
    used = sorted({reference["index"] for reference in references})
    mapping = {old: new for new, old in enumerate(used)}
    for reference in references:
        reference["index"] = mapping[reference["index"]]
    document["textures"] = [textures[index] for index in used]
    sources = []
    for texture in document["textures"]:
        if "source" in texture:
            sources.append(texture)
        sources.extend(value for value in texture.get("extensions", {}).values() if isinstance(value, dict) and "source" in value)
    images = document.get("images", [])
    used = sorted({source["source"] for source in sources})
    mapping = {old: new for new, old in enumerate(used)}
    for source in sources:
        source["source"] = mapping[source["source"]]
    document["images"] = [images[index] for index in used]


def prepare_scene(task, work_dir):
    input_dir = work_dir / "input"
    output_dir = work_dir / "output"
    input_dir.mkdir()
    output_dir.mkdir()
    assets = list(task.assets.all())
    source = input_dir / task.source_file.original_name
    shutil.copyfile(task.source_file.file.path, source)
    for asset in assets:
        shutil.copyfile(asset.file.path, input_dir / asset.original_name)
    if source.suffix.lower() == ".gltf":
        document = json.loads(source.read_text())
        for resource in document.get("buffers", []) + document.get("images", []):
            uri = resource.get("uri", "")
            if uri and not uri.startswith("data:"):
                try:
                    resource["uri"] = local_resource(input_dir, uri).name
                except RuntimeError:
                    if resource in document.get("buffers", []):
                        raise
        source.write_text(json.dumps(document))
    # Keep attachments alongside the intermediate scene for material references.
    for asset in assets:
        shutil.copyfile(asset.file.path, output_dir / asset.original_name)
    scene_path = output_dir / "scene.gltf"
    log = assimp_export(source, scene_path, "gltf")
    document = json.loads(scene_path.read_text())
    for resource in document.get("buffers", []):
        uri = resource.get("uri", "")
        if not uri or uri.startswith("data:"):
            continue
        try:
            path = local_resource(output_dir, uri)
        except RuntimeError:
            path = local_resource(input_dir, uri)
            shutil.copyfile(path, output_dir / path.name)
        resource["uri"] = path.name
    # Apply overrides before resolving images so a replacement can remove an
    # unavailable original texture without requiring the original filename.
    for image in document.get("images", []):
        uri = image.get("uri", "")
        if uri and not uri.startswith("data:"):
            try:
                path = local_resource(input_dir, uri)
                if not (output_dir / path.name).exists():
                    shutil.copyfile(path, output_dir / path.name)
                image["uri"] = path.name
            except RuntimeError:
                pass
    apply_textures(document, output_dir, assets)
    prune_unused_textures(document)
    # OBJ/FBX need real image files rather than glTF data URIs or buffer views.
    for index, image in enumerate(document.get("images", [])):
        uri = image.get("uri")
        if uri:
            data = read_uri(output_dir, uri)
        else:
            view = document["bufferViews"][image["bufferView"]]
            buffer = document["buffers"][view.get("buffer", 0)]
            start = view.get("byteOffset", 0)
            data = read_uri(output_dir, buffer["uri"])[start:start + view["byteLength"]]
        filename = f"embedded_image_{index}.png"
        with Image.open(io.BytesIO(data)) as decoded:
            decoded.convert("RGBA").save(output_dir / filename, format="PNG")
        image.pop("bufferView", None)
        image["mimeType"] = "image/png"
        image["uri"] = filename
    scene_path.write_text(json.dumps(document))
    preview = output_dir / "preview.glb"
    portable_glb(document, output_dir, preview)
    return output_dir, scene_path, preview, log
