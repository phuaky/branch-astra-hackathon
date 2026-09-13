import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneProps, Vec3 } from '../contracts';
import {
  buildConversationPaths,
  resolveLabelLayout,
  selectSceneLabels,
  suggestionPosition,
  type ConversationPath,
  type SceneLabel,
} from './layout';
import './conversation-scene.css';

const ACTUAL_START = new THREE.Color('#a9f6e8');
const ACTUAL_END = new THREE.Color('#5aa8d9');
const PRACTICE = new THREE.Color('#ee9b8d');
const SUGGESTED = new THREE.Color('#d5b879');
const TOPIC = new THREE.Color('#a7d8d0');
const ACTIVE = new THREE.Color('#effffb');
const SELECTED = new THREE.Color('#e7c982');
// Leave enough wall-clock headroom for the final draw frame on slower WebGL
// renderers while keeping the branch growth visible as a deliberate transition.
const ANIMATION_MS = 460;

interface AnimationRecord {
  topicId: string;
  line: THREE.Line;
  start: number;
  total: number;
  settled: boolean;
  settleTimer?: number;
}

interface SceneRuntime {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  content: THREE.Group;
  animations: THREE.Group;
  glowTexture: THREE.CanvasTexture;
  pickables: THREE.Object3D[];
  animationRecords: Map<string, AnimationRecord>;
  desiredPosition: THREE.Vector3;
  desiredTarget: THREE.Vector3;
  cameraMoving: boolean;
  resizeObserver: ResizeObserver;
  raf: number;
  lastFrame: number;
  frameIntervals: number[];
  pointerStart: { x: number; y: number } | null;
  pointerDragged: boolean;
}

export interface BranchSceneMark {
  name: string;
  topicId?: string;
  at: number;
}

export interface BranchSceneProbe {
  ready: boolean;
  rendererCount: number;
  projection: 'perspective';
  fov: number;
  following: boolean;
  manuallyExploring: boolean;
  activeTopicId: string | null;
  selectedTopicId: string | null;
  visibleLabels: Array<{
    id: string;
    kind: string;
    left: number;
    top: number;
    width: number;
    height: number;
    fontSize: number;
  }>;
  topicPositions: Record<string, Vec3>;
  paths: { actual: number; suggested: number; practice: number };
  pathStyles: Record<'actual' | 'suggested' | 'practice', {
    material: string;
    dashed: boolean;
    dashSize: number | null;
    gapSize: number | null;
    opacity: number;
  } | null>;
  marks: BranchSceneMark[];
  frameIntervals: number[];
  camera: { position: Vec3; target: Vec3 };
}

declare global {
  interface Window {
    __branchScene?: BranchSceneProbe;
  }
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material?.dispose();
  });
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function markScene(name: string, topicId?: string): void {
  performance.mark(name);
  const probe = window.__branchScene;
  if (!probe) return;
  probe.marks.push({ name, topicId, at: performance.now() });
  if (probe.marks.length > 240) probe.marks.splice(0, probe.marks.length - 240);
}

function settleAnimation(record: AnimationRecord, renderCompletedFrame: () => void): void {
  if (record.settled) return;
  record.line.geometry.setDrawRange(0, record.total);
  record.settled = true;
  if (record.settleTimer !== undefined) window.clearTimeout(record.settleTimer);
  renderCompletedFrame();
  markScene(`branch:topic:${record.topicId}:settled`, record.topicId);
}

function curvePoints(from: Vec3, to: Vec3, seed: string, segments = 36): THREE.Vector3[] {
  const start = new THREE.Vector3(...from);
  const end = new THREE.Vector3(...to);
  const delta = end.clone().sub(start);
  const midpoint = start.clone().add(end).multiplyScalar(0.5);
  const length = Math.max(0.5, delta.length());
  const seedValue = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0);
  const perpendicular = new THREE.Vector3(-delta.y, delta.x, delta.z * 0.18 + 0.25).normalize();
  midpoint.addScaledVector(perpendicular, Math.min(1.8, length * 0.18) * (seedValue % 2 ? 1 : -1));
  const curve = new THREE.QuadraticBezierCurve3(start, midpoint, end);
  return curve.getPoints(segments);
}

function coloredLineGeometry(points: THREE.Vector3[], startColor: THREE.Color, endColor: THREE.Color): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const colors: number[] = [];
  points.forEach((_, index) => {
    const color = startColor.clone().lerp(endColor, index / Math.max(1, points.length - 1));
    colors.push(color.r, color.g, color.b);
  });
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function makePathLine(path: ConversationPath, animate: boolean, muted = false): THREE.Line {
  const points = curvePoints(path.from, path.to, path.id);
  const geometry = path.kind === 'actual'
    ? coloredLineGeometry(points, ACTUAL_START, ACTUAL_END)
    : new THREE.BufferGeometry().setFromPoints(points);
  const material = path.kind === 'actual'
    ? new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: muted ? 0.075 : 0.92,
        blending: muted ? THREE.NormalBlending : THREE.AdditiveBlending,
      })
    : new THREE.LineDashedMaterial({ color: PRACTICE, transparent: true, opacity: muted ? 0.1 : 0.96, dashSize: 0.16, gapSize: 0.1 });
  const line = new THREE.Line(geometry, material);
  line.userData = { kind: path.kind, pathId: path.id, turnId: path.turnId };
  if (path.kind === 'practice') line.computeLineDistances();
  if (animate) geometry.setDrawRange(0, 0);
  return line;
}

function makeGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 60);
  gradient.addColorStop(0, 'rgba(191,255,239,.65)');
  gradient.addColorStop(0.2, 'rgba(122,224,207,.2)');
  gradient.addColorStop(1, 'rgba(43,122,130,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function addTopicNode(
  group: THREE.Group,
  topic: SceneProps['session']['topics'][number],
  active: boolean,
  selected: boolean,
  pickables: THREE.Object3D[],
  glowTexture: THREE.Texture,
  muted = false,
): void {
  const node = new THREE.Group();
  node.position.set(...topic.position);
  node.userData = { kind: 'topic', topicId: topic.id };

  const color = selected ? SELECTED : active ? ACTIVE : TOPIC;
  const radius = active || selected ? 0.29 : muted ? 0.1 : 0.205;
  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(radius, 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: active ? 1 : muted ? 0.16 : 0.96 }),
  );
  core.userData = node.userData;
  node.add(core);
  pickables.push(core);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color,
    transparent: true,
    opacity: active || selected ? 0.88 : muted ? 0.035 : 0.48,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(active || selected ? 2.2 : muted ? 0.85 : 1.42);
  node.add(halo);

  if (active || selected) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.75, 0.012, 8, 54),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending }),
    );
    ring.rotation.x = Math.PI / 2.35;
    node.add(ring);
  }
  group.add(node);
}

function addSuggestion(
  group: THREE.Group,
  session: SceneProps['session'],
  suggestion: SceneProps['session']['suggestions'][number],
  index: number,
  pickables: THREE.Object3D[],
): void {
  const anchor = session.topics.find((topic) => topic.id === suggestion.topicId);
  if (!anchor) return;
  const position = suggestionPosition(anchor.position, suggestion, index);
  const points = curvePoints(anchor.position, position, suggestion.id, 28);
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(
    geometry,
    new THREE.LineDashedMaterial({
      color: suggestion.recommended ? '#e8cc85' : SUGGESTED,
      transparent: true,
      opacity: suggestion.recommended ? 0.9 : 0.46,
      dashSize: suggestion.recommended ? 0.24 : 0.14,
      gapSize: suggestion.recommended ? 0.13 : 0.17,
    }),
  );
  line.computeLineDistances();
  line.userData = { kind: 'suggestion', suggestionId: suggestion.id };
  group.add(line);

  const node = new THREE.Mesh(
    new THREE.OctahedronGeometry(suggestion.recommended ? 0.18 : 0.13, 0),
    new THREE.MeshBasicMaterial({
      color: suggestion.recommended ? '#f4d88f' : '#c4aa70',
      transparent: true,
      opacity: suggestion.recommended ? 1 : 0.72,
      wireframe: !suggestion.recommended,
    }),
  );
  node.position.set(...position);
  node.rotation.z = Math.PI / 4;
  node.userData = {
    kind: 'suggestion',
    suggestionId: suggestion.id,
    topicId: suggestion.topicId,
    turnId: suggestion.turnIds.at(-1),
  };
  pickables.push(node);
  group.add(node);
}

function addAtmosphere(scene: THREE.Scene): void {
  const positions: number[] = [];
  for (let index = 0; index < 280; index += 1) {
    const x = Math.sin(index * 12.9898) * 22;
    const y = Math.sin(index * 78.233 + 4) * 13;
    const z = Math.cos(index * 37.719 + 1) * 17 - 4;
    positions.push(x, y, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({ color: '#86b8b5', size: 0.018, transparent: true, opacity: 0.22, depthWrite: false }),
  );
  points.name = 'atmosphere';
  scene.add(points);
}

function cameraDestination(
  session: SceneProps['session'],
  selectedTopicId: string | null,
  view: SceneProps['view'],
): { target: THREE.Vector3; position: THREE.Vector3 } {
  if (view === 'overview' && session.topics.length) {
    const box = new THREE.Box3();
    session.topics.forEach((topic) => box.expandByPoint(new THREE.Vector3(...topic.position)));
    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(4, size.length() * 0.62);
    return { target, position: target.clone().add(new THREE.Vector3(radius * 0.42, radius * 0.38, radius * 1.55)) };
  }
  const focusId = selectedTopicId ?? session.activeTopicId ?? session.topics.at(-1)?.id;
  const topic = session.topics.find((item) => item.id === focusId);
  if (view === 'focus' && topic) {
    const neighborhoodIds = new Set<string>([topic.id]);
    for (let index = session.turns.length - 1; index >= 0 && neighborhoodIds.size < 3; index -= 1) {
      const mapped = session.turnTopics[session.turns[index].id];
      if (mapped && session.topics.some((item) => item.id === mapped)) neighborhoodIds.add(mapped);
    }
    if (neighborhoodIds.size < 3) {
      for (const path of buildConversationPaths(session)) {
        if (path.fromTopicId === topic.id) neighborhoodIds.add(path.toTopicId);
        if (path.toTopicId === topic.id) neighborhoodIds.add(path.fromTopicId);
        if (neighborhoodIds.size >= 3) break;
      }
    }
    const box = new THREE.Box3();
    session.topics
      .filter((item) => neighborhoodIds.has(item.id))
      .forEach((item) => box.expandByPoint(new THREE.Vector3(...item.position)));
    const target = box.getCenter(new THREE.Vector3());
    const span = box.getSize(new THREE.Vector3()).length();
    const distance = Math.max(9.5, span * 2.15);
    return {
      target,
      position: target.clone().add(new THREE.Vector3(distance * 0.34, distance * 0.23, distance * 0.9)),
    };
  }
  const target = topic ? new THREE.Vector3(...topic.position) : new THREE.Vector3();
  return { target, position: target.clone().add(new THREE.Vector3(5.2, 3.4, 10.2)) };
}

function vecTuple(vector: THREE.Vector3): Vec3 {
  return [vector.x, vector.y, vector.z];
}

export default function ConversationScene({
  session,
  selectedTopicId,
  onSelectTopic,
  onSelectTurn,
  follow,
  onExplore,
  view,
  cameraReset,
}: SceneProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const labelElements = useRef(new Map<string, HTMLButtonElement>());
  const labelsRef = useRef<SceneLabel[]>([]);
  const callbacksRef = useRef({ onSelectTopic, onSelectTurn, onExplore });
  const manualRef = useRef(false);
  const knownTopicsRef = useRef(new Set<string>());
  const initializedTopicsRef = useRef(false);
  const followRef = useRef(follow);
  const probeFrameRef = useRef(0);

  const labels = useMemo(
    () => selectSceneLabels(session, selectedTopicId, view, 8),
    [session, selectedTopicId, view],
  );
  // Text/revision-only turn updates refresh the HTML labels without rebuilding
  // WebGL geometry. The key contains only values that affect nodes or paths.
  const geometryRevision = useMemo(() => JSON.stringify({
    topics: session.topics.map((topic) => [topic.id, topic.parentId, topic.position]),
    path: session.turns.map((turn) => [turn.id, session.turnTopics[turn.id], turn.sourceMode]),
    suggestions: session.suggestions.slice(0, 3).map((suggestion) => [
      suggestion.id,
      suggestion.topicId,
      suggestion.recommended,
      suggestion.turnIds.at(-1),
    ]),
    activeTopicId: session.activeTopicId,
    selectedTopicId,
  }), [session.topics, session.turns, session.turnTopics, session.suggestions, session.activeTopicId, selectedTopicId]);
  const cameraRevision = useMemo(() => JSON.stringify({
    topics: session.topics.map((topic) => [topic.id, topic.position]),
    activeTopicId: session.activeTopicId,
    selectedTopicId,
    view,
  }), [session.topics, session.activeTopicId, selectedTopicId, view]);
  labelsRef.current = labels;
  callbacksRef.current = { onSelectTopic, onSelectTurn, onExplore };
  followRef.current = follow;

  useLayoutEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2('#071017', 0.026);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 180);
    camera.position.set(4.2, 3, 9);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x05090e, 0);
    renderer.domElement.className = 'branch-scene__canvas';
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D conversation map');
    mount.prepend(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.enableDamping = true;
    controls.dampingFactor = 0.085;
    controls.screenSpacePanning = true;
    controls.minDistance = 2.8;
    controls.maxDistance = 42;
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;

    const content = new THREE.Group();
    const animations = new THREE.Group();
    const glowTexture = makeGlowTexture();
    scene.add(content, animations);
    addAtmosphere(scene);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const runtime: SceneRuntime = {
      scene,
      camera,
      renderer,
      controls,
      content,
      animations,
      glowTexture,
      pickables: [],
      animationRecords: new Map(),
      desiredPosition: camera.position.clone(),
      desiredTarget: controls.target.clone(),
      cameraMoving: false,
      resizeObserver,
      raf: 0,
      lastFrame: performance.now(),
      frameIntervals: [],
      pointerStart: null,
      pointerDragged: false,
    };
    runtimeRef.current = runtime;

    window.__branchScene = {
      ready: false,
      rendererCount: 1,
      projection: 'perspective',
      fov: camera.fov,
      following: followRef.current,
      manuallyExploring: false,
      activeTopicId: null,
      selectedTopicId: null,
      visibleLabels: [],
      topicPositions: {},
      paths: { actual: 0, suggested: 0, practice: 0 },
      pathStyles: { actual: null, suggested: null, practice: null },
      marks: [],
      frameIntervals: runtime.frameIntervals,
      camera: { position: vecTuple(camera.position), target: vecTuple(controls.target) },
    };

    const beginExplore = () => {
      if (manualRef.current) return;
      manualRef.current = true;
      runtime.cameraMoving = false;
      if (window.__branchScene) {
        window.__branchScene.following = false;
        window.__branchScene.manuallyExploring = true;
      }
      callbacksRef.current.onExplore();
    };

    const onPointerDown = (event: PointerEvent) => {
      runtime.pointerStart = { x: event.clientX, y: event.clientY };
      runtime.pointerDragged = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!runtime.pointerStart || runtime.pointerDragged) return;
      const distance = Math.hypot(event.clientX - runtime.pointerStart.x, event.clientY - runtime.pointerStart.y);
      if (distance > 5) {
        runtime.pointerDragged = true;
        beginExplore();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const wasClick = runtime.pointerStart && !runtime.pointerDragged;
      runtime.pointerStart = null;
      if (!wasClick) return;
      const bounds = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(runtime.pickables, false)[0]?.object;
      if (!hit) return;
      if (hit.userData.kind === 'topic') callbacksRef.current.onSelectTopic(hit.userData.topicId as string);
      if (hit.userData.kind === 'suggestion') {
        if (hit.userData.turnId) callbacksRef.current.onSelectTurn(hit.userData.turnId as string);
        else if (hit.userData.topicId) callbacksRef.current.onSelectTopic(hit.userData.topicId as string);
      }
    };
    const onWheel = () => beginExplore();
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

    const projected = new THREE.Vector3();
    const animate = (now: number) => {
      runtime.raf = requestAnimationFrame(animate);
      const interval = now - runtime.lastFrame;
      runtime.lastFrame = now;
      // Keep long frames so the performance probe cannot improve its own p95 by
      // discarding stalls. Six thousand samples covers well beyond a minute at 60 Hz.
      if (interval > 0) {
        runtime.frameIntervals.push(interval);
        if (runtime.frameIntervals.length > 6_000) runtime.frameIntervals.shift();
      }

      for (const record of runtime.animationRecords.values()) {
        if (record.settled) continue;
        const progress = Math.min(1, (now - record.start) / ANIMATION_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        record.line.geometry.setDrawRange(0, Math.max(2, Math.ceil(record.total * eased)));
        if (progress >= 1) settleAnimation(record, () => runtime.renderer.render(runtime.scene, runtime.camera));
      }

      if (runtime.cameraMoving && !manualRef.current) {
        camera.position.lerp(runtime.desiredPosition, 0.065);
        controls.target.lerp(runtime.desiredTarget, 0.075);
        if (
          camera.position.distanceToSquared(runtime.desiredPosition) < 0.0009 &&
          controls.target.distanceToSquared(runtime.desiredTarget) < 0.0009
        ) {
          camera.position.copy(runtime.desiredPosition);
          controls.target.copy(runtime.desiredTarget);
          runtime.cameraMoving = false;
        }
      }
      controls.update();

      const width = mount.clientWidth;
      const height = mount.clientHeight;
      const candidates = labelsRef.current.flatMap((label) => {
        const element = labelElements.current.get(label.id);
        if (!element) return [];
        projected.set(...label.world).project(camera);
        if (projected.z < -1 || projected.z > 1) return [];
        return [{
          id: label.id,
          anchorX: (projected.x * 0.5 + 0.5) * width,
          anchorY: (-projected.y * 0.5 + 0.5) * height,
          width: element.offsetWidth || 224,
          height: element.offsetHeight || 72,
          priority: label.priority,
        }];
      });
      const placements = resolveLabelLayout(candidates, width, height, 8);
      const placementById = new Map(placements.map((placement) => [placement.id, placement]));
      for (const label of labelsRef.current) {
        const element = labelElements.current.get(label.id);
        if (!element) continue;
        const placement = placementById.get(label.id);
        if (!placement) {
          element.style.opacity = '0';
          element.style.pointerEvents = 'none';
        } else {
          element.style.transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;
          element.style.opacity = '1';
          element.style.pointerEvents = 'auto';
        }
      }

      probeFrameRef.current += 1;
      if (window.__branchScene && probeFrameRef.current % 6 === 0) {
        window.__branchScene.visibleLabels = placements.map((placement) => {
          const label = labelsRef.current.find((item) => item.id === placement.id);
          return {
            id: placement.id,
            kind: label?.kind ?? 'unknown',
            left: placement.left,
            top: placement.top,
            width: placement.width,
            height: placement.height,
            fontSize: 16,
          };
        });
        window.__branchScene.camera = { position: vecTuple(camera.position), target: vecTuple(controls.target) };
      }
      renderer.render(scene, camera);
    };
    runtime.raf = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(runtime.raf);
      for (const record of runtime.animationRecords.values()) {
        if (record.settleTimer !== undefined) window.clearTimeout(record.settleTimer);
      }
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      controls.dispose();
      disposeObject(scene);
      glowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
      delete window.__branchScene;
    };
  }, []);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    // Completed overlays can become ordinary static paths on the next data update.
    for (const [topicId, record] of runtime.animationRecords) {
      if (!record.settled) continue;
      runtime.animations.remove(record.line);
      disposeObject(record.line);
      runtime.animationRecords.delete(topicId);
    }

    const currentIds = new Set(session.topics.map((topic) => topic.id));
    const newIds = initializedTopicsRef.current
      ? session.topics.filter((topic) => !knownTopicsRef.current.has(topic.id)).map((topic) => topic.id)
      : [];
    initializedTopicsRef.current = true;
    knownTopicsRef.current = currentIds;

    newIds.forEach((topicId) => markScene(`branch:topic:${topicId}:received`, topicId));
    clearGroup(runtime.content);
    runtime.pickables = [];
    const paths = buildConversationPaths(session);
    const focusTopicIds = new Set(
      labelsRef.current.flatMap((label) => label.topicId ? [label.topicId] : []),
    );
    if (session.activeTopicId) focusTopicIds.add(session.activeTopicId);
    if (selectedTopicId) focusTopicIds.add(selectedTopicId);

    for (const path of paths) {
      const existingAnimation = runtime.animationRecords.get(path.toTopicId);
      if (existingAnimation) continue;
      const shouldAnimate = newIds.includes(path.toTopicId);
      const muted = view === 'focus' && !focusTopicIds.has(path.fromTopicId) && !focusTopicIds.has(path.toTopicId);
      const line = makePathLine(path, shouldAnimate, muted);
      if (shouldAnimate) {
        runtime.animations.add(line);
        const total = line.geometry.getAttribute('position').count;
        const start = performance.now();
        const record: AnimationRecord = {
          topicId: path.toTopicId,
          line,
          start,
          total,
          settled: false,
        };
        // rAF can be paused by a slow GPU frame even while the page timer queue
        // remains responsive. Complete the draw range on the same wall clock so
        // a renderer stall cannot extend the transition past its intended bound.
        record.settleTimer = window.setTimeout(() => settleAnimation(
          record,
          () => runtime.renderer.render(runtime.scene, runtime.camera),
        ), ANIMATION_MS);
        runtime.animationRecords.set(path.toTopicId, record);
        markScene(`branch:topic:${path.toTopicId}:start`, path.toTopicId);
      } else {
        runtime.content.add(line);
      }
    }

    for (const topic of session.topics) {
      addTopicNode(
        runtime.content,
        topic,
        topic.id === session.activeTopicId,
        topic.id === selectedTopicId,
        runtime.pickables,
        runtime.glowTexture,
        view === 'focus' && !focusTopicIds.has(topic.id),
      );
    }
    session.suggestions.slice(0, 3).forEach((suggestion, index) => {
      addSuggestion(runtime.content, session, suggestion, index, runtime.pickables);
    });

    if (window.__branchScene) {
      window.__branchScene.ready = true;
      window.__branchScene.activeTopicId = session.activeTopicId;
      window.__branchScene.selectedTopicId = selectedTopicId;
      window.__branchScene.topicPositions = Object.fromEntries(
        session.topics.map((topic) => [topic.id, [...topic.position] as Vec3]),
      );
      window.__branchScene.paths = {
        actual: paths.filter((path) => path.kind === 'actual').length,
        practice: paths.filter((path) => path.kind === 'practice').length,
        suggested: Math.min(3, session.suggestions.length),
      };
      const pathStyles: BranchSceneProbe['pathStyles'] = {
        actual: null,
        suggested: null,
        practice: null,
      };
      runtime.content.traverse((object) => {
        const rawKind = object.userData.kind as 'actual' | 'suggestion' | 'practice' | undefined;
        const kind = rawKind === 'suggestion' ? 'suggested' : rawKind;
        if (!kind || !(kind in pathStyles) || pathStyles[kind]) return;
        const material = (object as THREE.Line).material as THREE.LineBasicMaterial | THREE.LineDashedMaterial | undefined;
        if (!material) return;
        const dashed = material instanceof THREE.LineDashedMaterial;
        pathStyles[kind] = {
          material: material.type,
          dashed,
          dashSize: dashed ? material.dashSize : null,
          gapSize: dashed ? material.gapSize : null,
          opacity: material.opacity,
        };
      });
      window.__branchScene.pathStyles = pathStyles;
    }
  }, [geometryRevision, view]);

  useEffect(() => {
    if (!follow) return;
    manualRef.current = false;
    if (window.__branchScene) {
      window.__branchScene.following = true;
      window.__branchScene.manuallyExploring = false;
    }
  }, [follow]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !follow || manualRef.current) return;
    const destination = cameraDestination(session, selectedTopicId, view);
    runtime.desiredPosition.copy(destination.position);
    runtime.desiredTarget.copy(destination.target);
    runtime.cameraMoving = true;
  }, [cameraRevision, follow]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    manualRef.current = false;
    const destination = cameraDestination(session, selectedTopicId, view);
    runtime.desiredPosition.copy(destination.position);
    runtime.desiredTarget.copy(destination.target);
    runtime.cameraMoving = true;
    if (window.__branchScene) {
      window.__branchScene.following = true;
      window.__branchScene.manuallyExploring = false;
    }
  }, [cameraReset]);

  const activateLabel = (label: SceneLabel) => {
    if (label.turnId) onSelectTurn(label.turnId);
    else if (label.topicId) onSelectTopic(label.topicId);
  };

  return (
    <div className="branch-scene" data-view={view} data-testid="conversation-scene">
      <div ref={mountRef} className="branch-scene__viewport" />
      <div className="branch-scene__vignette" aria-hidden="true" />
      <div className="branch-scene__labels" aria-label="Conversation map details">
        {labels.map((label) => (
          <button
            key={label.id}
            ref={(element) => {
              if (element) labelElements.current.set(label.id, element);
              else labelElements.current.delete(label.id);
            }}
            type="button"
            className={`branch-scene__label branch-scene__label--${label.kind}${label.recommended ? ' is-recommended' : ''}`}
            data-scene-label={label.id}
            data-label-kind={label.kind}
            onClick={() => activateLabel(label)}
            aria-label={`${label.kicker}: ${label.title}`}
          >
            {label.kind !== 'topic' && <span className="branch-scene__label-kicker">{label.kicker}</span>}
            <span className="branch-scene__label-title">{label.title}</span>
            {label.detail && <span className="branch-scene__label-detail">{label.detail}</span>}
          </button>
        ))}
      </div>
      <div className="branch-scene__legend" aria-label="Path styles">
        <span><i className="branch-scene__key branch-scene__key--actual" />Actual</span>
        <span><i className="branch-scene__key branch-scene__key--suggested" />Suggested</span>
        <span><i className="branch-scene__key branch-scene__key--practice" />Practice</span>
      </div>
      <div className="branch-scene__hint">Drag to pan <b>·</b> Scroll to zoom</div>
    </div>
  );
}
