import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Cable, Focus, MousePointer2, Rotate3D } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { OpenCarAnalysisCase, OpenCarCaseId, OpenCarConnectionRow } from './opencar-data';
import vehicleLayout from './opencar-vehicle-layout.json';

interface OpenCarVehicleSceneProps {
  activeCase: OpenCarCaseId;
  analysis: OpenCarAnalysisCase;
}

interface ComponentPosition {
  x: number;
  y: number;
  z: number;
}

interface ConnectionVisual {
  core: THREE.Mesh;
  glow: THREE.Mesh;
  color: number;
}

type CableKind = 'radar' | 'camera' | 'perception' | 'brake' | 'steering' | 'network';
type VehicleAssetState = 'loading' | 'ready' | 'error';

const VEHICLE_ASSET_URL = '/model-assets/opencar/car-concept.glb';
const VEHICLE_ASSET_SOURCE_URL = 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept';

// CarConcept 经加载后以 +Z 指向车头；位置数据独立治理，避免把架构分配关系误作物理安装位置。
const CASE_COMPONENT_POSITIONS: Record<OpenCarCaseId, Record<string, ComponentPosition>> = vehicleLayout.cases;
const COMPONENT_INSTALLATIONS: Record<string, string> = vehicleLayout.componentInstallations;

const COMPONENT_COLORS: Record<string, number> = {
  sensor: 0x38bdf8,
  compute: 0xa78bfa,
  actuator: 0xf59e0b
};

const CABLE_STYLES: Record<CableKind, number> = {
  radar: 0x22d3ee,
  camera: 0xec4899,
  perception: 0x8b5cf6,
  brake: 0xf59e0b,
  steering: 0x22c55e,
  network: 0x60a5fa
};

export function OpenCarVehicleScene({ activeCase, analysis }: OpenCarVehicleSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const componentMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const connectionVisualsRef = useRef<Map<number, ConnectionVisual>>(new Map());
  const [selectedComponentId, setSelectedComponentId] = useState(() => defaultSelectedComponent(activeCase));
  const [selectedConnectionIndex, setSelectedConnectionIndex] = useState<number | null>(0);
  const [vehicleAssetState, setVehicleAssetState] = useState<VehicleAssetState>('loading');
  const componentIds = useMemo(() => Object.keys(CASE_COMPONENT_POSITIONS[activeCase]), [activeCase]);
  const selectedConnection = selectedConnectionIndex === null ? null : analysis.connections[selectedConnectionIndex] || null;

  useEffect(() => {
    setSelectedComponentId(defaultSelectedComponent(activeCase));
    setSelectedConnectionIndex(0);
  }, [activeCase]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    setVehicleAssetState('loading');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07111f);
    scene.fog = new THREE.FogExp2(0x07111f, 0.034);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const cameraOrbit = { yaw: 0.72, pitch: 0.42, distance: 13.4 };
    const cameraTarget = new THREE.Vector3(0, 0.18, 0);
    const updateCamera = () => {
      const horizontalDistance = Math.cos(cameraOrbit.pitch) * cameraOrbit.distance;
      camera.position.set(
        Math.sin(cameraOrbit.yaw) * horizontalDistance,
        Math.sin(cameraOrbit.pitch) * cameraOrbit.distance,
        Math.cos(cameraOrbit.yaw) * horizontalDistance
      );
      camera.lookAt(cameraTarget);
    };
    updateCamera();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xd7efff, 0x0b1020, 2.45));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(5, 8, -3);
    scene.add(keyLight);
    const sideLight = new THREE.DirectionalLight(0x38bdf8, 2.1);
    sideLight.position.set(-6, 3, 1);
    scene.add(sideLight);
    const rimLight = new THREE.PointLight(0x2563eb, 42, 24);
    rimLight.position.set(-4, 3, -2);
    scene.add(rimLight);

    const grid = new THREE.GridHelper(18, 24, 0x1d4ed8, 0x1e293b);
    grid.position.y = -0.78;
    scene.add(grid);

    let assetCancelled = false;
    const loader = new GLTFLoader();
    loader.loadAsync(VEHICLE_ASSET_URL)
      .then((gltf) => {
        const vehicle = configureImportedVehicle(gltf.scene);
        if (assetCancelled) {
          disposeObjectTree(vehicle);
          return;
        }
        scene.add(vehicle);
        setVehicleAssetState('ready');
      })
      .catch(() => {
        if (assetCancelled) return;
        scene.add(buildVehicleAssetFallback());
        setVehicleAssetState('error');
      });

    const componentMeshes = new Map<string, THREE.Mesh>();
    const connectionVisuals = new Map<number, ConnectionVisual>();
    const interactiveMeshes: THREE.Object3D[] = [];
    for (const [componentId, position] of Object.entries(CASE_COMPONENT_POSITIONS[activeCase])) {
      const kind = componentKind(componentId);
      const geometry = new THREE.BoxGeometry(kind === 'compute' ? 0.72 : 0.52, kind === 'compute' ? 0.42 : 0.34, kind === 'compute' ? 0.72 : 0.52);
      const material = new THREE.MeshStandardMaterial({
        color: COMPONENT_COLORS[kind],
        emissive: COMPONENT_COLORS[kind],
        emissiveIntensity: 0.55,
        roughness: 0.24,
        metalness: 0.35,
        depthTest: false
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(position.x, position.y, position.z);
      mesh.userData = { type: 'component', componentId };
      mesh.renderOrder = 20;
      componentMeshes.set(componentId, mesh);
      interactiveMeshes.push(mesh);
      scene.add(mesh);

      const glow = new THREE.PointLight(COMPONENT_COLORS[kind], 2.6, 2.2);
      glow.position.copy(mesh.position);
      scene.add(glow);
    }

    analysis.connections.forEach((connection, connectionIndex) => {
      const start = CASE_COMPONENT_POSITIONS[activeCase][connection.start];
      const end = CASE_COMPONENT_POSITIONS[activeCase][connection.end];
      if (!start || !end) return;
      const cableKind = cableKindFor(connection);
      const color = CABLE_STYLES[cableKind];
      const route = createHarnessRoute(start, end, connectionIndex);
      const core = new THREE.Mesh(
        new THREE.TubeGeometry(route, 42, 0.055, 10, false),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 1.05,
          roughness: 0.2,
          metalness: 0.18,
          depthTest: false
        })
      );
      core.userData = { type: 'connection', connectionIndex };
      core.renderOrder = 30;

      const glow = new THREE.Mesh(
        new THREE.TubeGeometry(route, 42, 0.115, 10, false),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.13,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false
        })
      );
      glow.renderOrder = 29;

      connectionVisuals.set(connectionIndex, { core, glow, color });
      interactiveMeshes.push(core);
      scene.add(glow, core);
    });
    componentMeshesRef.current = componentMeshes;
    connectionVisualsRef.current = connectionVisuals;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const pointerState = { active: false, moved: false, x: 0, y: 0 };
    const handlePointerDown = (event: PointerEvent) => {
      pointerState.active = true;
      pointerState.moved = false;
      pointerState.x = event.clientX;
      pointerState.y = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerState.active) return;
      const deltaX = event.clientX - pointerState.x;
      const deltaY = event.clientY - pointerState.y;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 2) pointerState.moved = true;
      cameraOrbit.yaw -= deltaX * 0.008;
      cameraOrbit.pitch = THREE.MathUtils.clamp(cameraOrbit.pitch + deltaY * 0.006, 0.14, 1.18);
      pointerState.x = event.clientX;
      pointerState.y = event.clientY;
      updateCamera();
    };
    const handlePointerUp = (event: PointerEvent) => {
      const wasDragged = pointerState.moved;
      pointerState.active = false;
      renderer.domElement.releasePointerCapture(event.pointerId);
      if (wasDragged) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(interactiveMeshes, false)[0]?.object;
      if (hit?.userData.type === 'component') {
        setSelectedComponentId(String(hit.userData.componentId));
        setSelectedConnectionIndex(null);
      }
      if (hit?.userData.type === 'connection') {
        const connectionIndex = Number(hit.userData.connectionIndex);
        setSelectedConnectionIndex(connectionIndex);
        setSelectedComponentId(analysis.connections[connectionIndex]?.end || defaultSelectedComponent(activeCase));
      }
    };
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraOrbit.distance = THREE.MathUtils.clamp(cameraOrbit.distance + event.deltaY * 0.012, 7, 19);
      updateCamera();
    };
    renderer.domElement.addEventListener('pointerdown', handlePointerDown);
    renderer.domElement.addEventListener('pointermove', handlePointerMove);
    renderer.domElement.addEventListener('pointerup', handlePointerUp);
    renderer.domElement.addEventListener('wheel', handleWheel, { passive: false });

    const resize = () => {
      const width = Math.max(mount.clientWidth, 320);
      const height = Math.max(mount.clientHeight, 360);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let animationFrame = 0;
    const animate = () => {
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      assetCancelled = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('wheel', handleWheel);
      disposeObjectTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
      componentMeshesRef.current = new Map();
      connectionVisualsRef.current = new Map();
    };
  }, [activeCase, analysis]);

  useEffect(() => {
    componentMeshesRef.current.forEach((mesh, componentId) => {
      const isSelected = selectedConnectionIndex === null && componentId === selectedComponentId;
      mesh.scale.setScalar(isSelected ? 1.22 : 1);
      const material = mesh.material;
      if (material instanceof THREE.MeshStandardMaterial) material.emissiveIntensity = isSelected ? 1.85 : 0.55;
    });
    connectionVisualsRef.current.forEach((visual, connectionIndex) => {
      const isSelected = connectionIndex === selectedConnectionIndex;
      const coreMaterial = visual.core.material;
      const glowMaterial = visual.glow.material;
      if (coreMaterial instanceof THREE.MeshStandardMaterial) {
        coreMaterial.color.setHex(visual.color);
        coreMaterial.emissive.setHex(visual.color);
        coreMaterial.emissiveIntensity = isSelected ? 2.6 : 1.05;
      }
      if (glowMaterial instanceof THREE.MeshBasicMaterial) glowMaterial.opacity = isSelected ? 0.48 : 0.13;
    });
  }, [selectedComponentId, selectedConnectionIndex]);

  const selectComponent = (componentId: string) => {
    setSelectedComponentId(componentId);
    setSelectedConnectionIndex(null);
  };

  const selectConnection = (connection: OpenCarConnectionRow, connectionIndex: number) => {
    setSelectedConnectionIndex(connectionIndex);
    setSelectedComponentId(connection.end);
  };

  return (
    <div className="openCarVehicleScene">
      <div className="openCarVehicleViewport" ref={mountRef} role="img" aria-label={`${analysis.label} 电动快背轿车三维部件与多色线束视图`} />
      <div className="openCarSceneHud" aria-live="polite">
        <div className="openCarSceneMode">
          <Rotate3D size={15} />
          <span>拖拽旋转 · 滚轮缩放 · 开源概念车外壳</span>
        </div>
        <div className="openCarSceneSelection">
          {selectedConnection ? <Cable size={16} /> : <Focus size={16} />}
          <div>
            <span>{selectedConnection ? '当前线束' : '当前部件'}</span>
            <strong>{selectedConnection ? `${selectedConnection.start} → ${selectedConnection.end}` : selectedComponentId}</strong>
            <small>{selectedConnection ? `${selectedConnection.signal} · ${selectedConnection.lengthM} m` : `${componentKindLabel(selectedComponentId)} · ${componentInstallationLabel(selectedComponentId)}`}</small>
          </div>
        </div>
        <div className="openCarVehicleAssetCredit" data-asset-state={vehicleAssetState}>
          <span>{vehicleAssetState === 'loading' ? '正在加载开源整车模型…' : vehicleAssetState === 'error' ? '整车模型加载失败，已显示降级轮廓' : '开源整车模型已加载'}</span>
          <a href={VEHICLE_ASSET_SOURCE_URL} target="_blank" rel="noreferrer">Khronos CarConcept</a>
          <small>Eric Chadwick / DGG · CC BY 4.0</small>
        </div>
      </div>
      <div className="openCarSceneLegend" aria-label="三维模型部件筛选">
        <div className="openCarSceneLegendTitle"><Box size={15} /><strong>SysML 部件</strong><span>{componentIds.length}</span></div>
        <div className="openCarSceneChipList">
          {componentIds.map((componentId) => (
            <button
              key={componentId}
              type="button"
              className={selectedConnectionIndex === null && selectedComponentId === componentId ? 'active' : ''}
              onClick={() => selectComponent(componentId)}
            >
              <i data-kind={componentKind(componentId)} />
              {componentId}
            </button>
          ))}
        </div>
        <div className="openCarSceneLegendTitle"><Cable size={15} /><strong>布线路径</strong><span>{analysis.connections.length}</span></div>
        <div className="openCarSceneRouteList">
          {analysis.connections.map((connection, connectionIndex) => (
            <button
              key={`${connection.start}-${connection.end}-${connectionIndex}`}
              type="button"
              data-cable-kind={cableKindFor(connection)}
              className={selectedConnectionIndex === connectionIndex ? 'active' : ''}
              onClick={() => selectConnection(connection, connectionIndex)}
            >
              <MousePointer2 size={13} />
              <span>{connection.start} → {connection.end}</span>
              <small>{connection.lengthM} m</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function configureImportedVehicle(model: THREE.Group): THREE.Group {
  const group = new THREE.Group();
  const shellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x8dd8ff,
    emissive: 0x0c4a6e,
    emissiveIntensity: 0.16,
    transparent: true,
    opacity: 0.3,
    roughness: 0.18,
    metalness: 0.3,
    transmission: 0.15,
    thickness: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x164e63,
    transparent: true,
    opacity: 0.24,
    roughness: 0.06,
    metalness: 0.08,
    transmission: 0.38,
    thickness: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const interiorMaterial = new THREE.MeshStandardMaterial({
    color: 0x334155,
    transparent: true,
    opacity: 0.16,
    roughness: 0.54,
    metalness: 0.22,
    depthWrite: false
  });
  const paintNodePattern = /^(BodyRoofPanel|BodyRearPanelsColor1|BodyPillars|BodyPanelsColor2|BodyHood$|BodyDoor[LR]Color[12]|BodyDoor[LR]MirrorColor[12])/;
  const glassNodePattern = /(Windshield|Rearwindow|WindowsRearSides|Door[LR]Window$)/;
  const subduedNodePattern = /^(Interior|Engine$|BodyUnderside$|Axles$)/;
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.name === 'License Plate' || object.name === 'InteriorSteeringEmblem') {
      object.visible = false;
      return;
    }
    if (paintNodePattern.test(object.name)) {
      object.material = shellMaterial;
      object.renderOrder = 3;
      const contour = new THREE.LineSegments(
        new THREE.EdgesGeometry(object.geometry, 34),
        new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.42, depthTest: false })
      );
      contour.renderOrder = 9;
      object.add(contour);
      return;
    }
    if (glassNodePattern.test(object.name)) {
      object.material = glassMaterial;
      object.renderOrder = 4;
      return;
    }
    if (subduedNodePattern.test(object.name)) {
      object.material = interiorMaterial;
      object.renderOrder = 2;
    }
  });
  const modelFrame = new THREE.Group();
  const orientationMatrix = new THREE.Matrix4().makeScale(1.52, 1.52, 1.52);
  modelFrame.matrix.copy(orientationMatrix);
  modelFrame.matrixAutoUpdate = false;
  modelFrame.add(model);
  modelFrame.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(modelFrame);
  const center = bounds.getCenter(new THREE.Vector3());
  modelFrame.matrix.premultiply(new THREE.Matrix4().makeTranslation(-center.x, -0.72 - bounds.min.y, -center.z));
  modelFrame.updateMatrixWorld(true);
  group.add(modelFrame);

  const battery = new THREE.Mesh(
    new THREE.BoxGeometry(2.75, 0.12, 4.35),
    new THREE.MeshStandardMaterial({ color: 0x0f766e, emissive: 0x0f766e, emissiveIntensity: 0.34, transparent: true, opacity: 0.34, depthWrite: false })
  );
  battery.position.set(0, -0.48, 0.12);
  battery.renderOrder = 8;
  group.add(battery);
  return group;
}

function buildVehicleAssetFallback(): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(3.7, 1.4, 7.1);
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.58 })
  );
  outline.position.y = -0.02;
  group.add(outline);
  return group;
}

function disposeObjectTree(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.LineSegments)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

function createHarnessRoute(start: ComponentPosition, end: ComponentPosition, connectionIndex: number): THREE.CatmullRomCurve3 {
  const startPoint = new THREE.Vector3(start.x, start.y, start.z);
  const endPoint = new THREE.Vector3(end.x, end.y, end.z);
  const laneOffset = ((connectionIndex % 5) - 2) * 0.12;
  const middleZ = (start.z + end.z) / 2;
  const harnessY = -0.03 + (connectionIndex % 2) * 0.08;
  const controlA = new THREE.Vector3(start.x + laneOffset, harnessY, middleZ);
  const controlB = new THREE.Vector3(end.x + laneOffset, harnessY, middleZ);
  return new THREE.CatmullRomCurve3([startPoint, controlA, controlB, endPoint], false, 'catmullrom', 0.2);
}

function cableKindFor(connection: OpenCarConnectionRow): CableKind {
  if (connection.signal === 'front_radar_object_list') return 'radar';
  if (connection.signal === 'front_camera_object_list') return 'camera';
  if (connection.signal === 'detected_front_object') return 'perception';
  if (connection.signal === 'brake_request') return 'brake';
  if (connection.signal === 'steering_request') return 'steering';
  return 'network';
}

function componentKind(componentId: string): 'sensor' | 'compute' | 'actuator' {
  if (/radar|camera/.test(componentId)) return 'sensor';
  if (/actuator/.test(componentId)) return 'actuator';
  return 'compute';
}

function componentKindLabel(componentId: string): string {
  const kind = componentKind(componentId);
  if (kind === 'sensor') return '传感器部件 · Sensor';
  if (kind === 'actuator') return '执行器部件 · Actuator';
  return '计算与控制部件 · Compute Unit';
}

function componentInstallationLabel(componentId: string): string {
  return COMPONENT_INSTALLATIONS[componentId] || '工程安装位置待定义';
}

function defaultSelectedComponent(activeCase: OpenCarCaseId): string {
  return activeCase === 'zonal' ? 'central_compute' : 'adas_domain_controller';
}
