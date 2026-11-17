// The light the table is seen in, shared by the app and the launch video: a photographed
// studio (Poly Haven HDRI, CC0) for reflections and soft fill, one key light for crisp
// shadows, an invisible floor that only catches shadow, and the blue backdrop. Tone
// mapping is Khronos PBR Neutral, made for product renders: colours stay true.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

const HDRI = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/white_studio_05_1k.hdr';

export function backdrop(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d')!, r = g.createRadialGradient(256, 195, 0, 256, 195, 420);
  r.addColorStop(0, '#2f78ff'); r.addColorStop(0.42, '#1f5be6'); r.addColorStop(0.78, '#1b47c7'); r.addColorStop(1, '#1a3aa8');
  g.fillStyle = r; g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface Studio { key: THREE.DirectionalLight; ready: Promise<void>; fit(span: number, centre?: THREE.Vector3): void; rig(width: number, depth: number, top: number): void }

export function createStudio(renderer: THREE.WebGLRenderer, scene: THREE.Scene, onChange: () => void = () => {}): Studio {
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  scene.background = backdrop();
  scene.backgroundIntensity = 1;

  // reflections: a neutral room until the photographed studio arrives
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.8;
  const ready = new HDRLoader().loadAsync(HDRI).then(hdr => {
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 1.0;
    scene.environmentRotation.set(0, -0.6, 0);
    hdr.dispose();
    onChange();
  }).catch(() => { /* offline: the neutral room stays */ });

  // the rig's own light: a diffuse panel the size of the box, just under the top rails,
  // lighting the whole workspace evenly, as on a real test rig
  RectAreaLightUniformsLib.init();
  const panel = new THREE.RectAreaLight(0xffffff, 3.2, 1, 1);
  scene.add(panel);

  // a faint key from high front left: only enough to ground the table with a soft shadow
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 22;
  key.shadow.blurSamples = 25;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.015;
  scene.add(key, key.target);

  // a floor you never see: it only darkens where the table shades it
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.ShadowMaterial({ opacity: 0.32, color: 0x05164f }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  return {
    key, ready,
    rig(width: number, depth: number, top: number) {   // metres, three's y-up frame
      panel.width = width * 0.92; panel.height = depth * 0.92;
      panel.position.set(0, top - 0.03, 0);
      panel.lookAt(0, 0, 0);
    },
    fit(span: number, centre = new THREE.Vector3()) {
      key.position.copy(centre).add(new THREE.Vector3(-2.2, 5, 2.8).multiplyScalar(span));
      key.target.position.copy(centre);
      Object.assign(key.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.05, far: 20 * span });
      key.shadow.camera.updateProjectionMatrix();
    },
  };
}
