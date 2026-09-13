import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ArrowLeft, ArrowRight, BookOpen, CornerDownRight, Check, Target, History, Sparkles } from 'lucide-react';
import type { SceneProps, Vec3 } from '../contracts';
import type { BranchSceneProbe } from './ConversationScene';
import { formatTime } from '../input/transcript';
import { resolveLabelLayout } from './layout';
import { branchPosition, buildConversationTrail, decisionPoints, focusedDecision, focusedVisit, nextBranches, visibleVisits, type TrailVisit } from './trail';
import { moveLabels } from '../coach/strategy';
import './conversation-trail.css';

interface TrailProps extends SceneProps {
  selectedTurnId: string | null;
  onOpenSource: () => void;
  mapping: boolean;
  mapError: string | null;
  onRetry: () => void;
  onChooseBranch: (throughTurnId: string, suggestionId: string) => void;
  onEditBrief: () => void;
}

interface Label {
  id: string;
  kind: 'turn' | 'topic' | 'suggestion';
  world: Vec3;
  title: string;
  kicker: string;
  detail?: string;
  turnId?: string;
  visit?: TrailVisit;
  current?: boolean;
  recommended?: boolean;
  priority: number;
}

interface Growth {
  id: string;
  topicId: string;
  line: THREE.Line;
  start: number;
  count: number;
  settled: boolean;
  settleTimer?: number;
}

interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  pickables: THREE.Object3D[];
  growth: Growth[];
  goal: { position: THREE.Vector3; target: THREE.Vector3 } | null;
  manual: boolean;
  width: number;
  height: number;
  fit: () => void;
  pulses: Array<{ mesh: THREE.Mesh; path: THREE.QuadraticBezierCurve3 }>;
}

declare global {
  interface Window {
    __branchTrail?: {
      visits: Array<{ id: string; topicId: string; position: Vec3; turnIds: string[]; returning: boolean }>;
      renderedVisits: number;
      selectedVisitId: string | null;
      focusedVisitId: string | null;
      branchCount: number;
      chosenSuggestionId: string | null;
      chosenPathMeshes: number;
      decisionTurnId: string | null;
      savedDecisions: number;
      view: SceneProps['view'];
      cameraSettled: boolean;
    };
  }
}

const MINT = '#a9eed8';
const GOLD = '#e9c881';
const PRACTICE = '#c8aff6';
const GROWTH_MS = 460;
const vector = (position: Vec3) => new THREE.Vector3(...position);
const tuple = (value: THREE.Vector3): Vec3 => [value.x, value.y, value.z];

function dispose(object: THREE.Object3D) {
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach(material => material?.dispose());
  });
}

function curve(from: Vec3, to: Vec3, future = false) {
  const start = vector(from);
  const end = vector(to);
  const middle = start.clone().lerp(end, 0.5);
  middle.y -= future ? 0.18 : 0.65;
  middle.z -= future ? 0.1 : 0.5;
  return new THREE.QuadraticBezierCurve3(start, middle, end);
}

function mark(name: string, topicId: string) {
  const value = { name: `branch:topic:${topicId}:${name}`, topicId, at: performance.now() };
  window.__branchScene?.marks.push(value);
  if (window.__branchScene && window.__branchScene.marks.length > 240) window.__branchScene.marks.splice(0, window.__branchScene.marks.length - 240);
}

function settleGrowth(growth: Growth, runtime: Runtime) {
  if (growth.settled) return;
  growth.line.geometry.setDrawRange(0, growth.count);
  growth.settled = true;
  if (growth.settleTimer !== undefined) window.clearTimeout(growth.settleTimer);
  // Render the completed geometry before publishing the settled mark. This makes
  // the probe timestamp describe a frame Three has actually drawn, not timer state.
  runtime.renderer.render(runtime.scene, runtime.camera);
  mark('settled', growth.topicId);
}

function fitCamera(runtime: Runtime, points: Vec3[], rightInset = 0) {
  if (!points.length) points = [[0, 0, 0]];
  const box = new THREE.Box3().setFromPoints(points.map(vector));
  const target = box.getCenter(new THREE.Vector3());
  target.y += 1.15;
  const direction = new THREE.Vector3(0, 0.24, 1).normalize();
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const tanY = Math.tan(THREE.MathUtils.degToRad(runtime.camera.fov / 2));
  const availableX = Math.max(0.25, (runtime.width - rightInset - 110) / runtime.width);
  const availableY = Math.max(0.24, (runtime.height - 260) / runtime.height);
  let distance = 13;
  for (const point of points) {
    const delta = vector(point).sub(target);
    const depth = delta.dot(direction);
    distance = Math.max(distance,
      Math.abs(delta.dot(right)) / (tanY * runtime.camera.aspect * availableX) + depth,
      Math.abs(delta.dot(up)) / (tanY * availableY) + depth);
  }
  runtime.camera.far = Math.max(300, distance * 5 + box.getSize(new THREE.Vector3()).length() * 2);
  // Keep perspective geometry in the open map space beside the full-text cards.
  runtime.camera.setViewOffset(runtime.width, runtime.height, rightInset / 2, 0, runtime.width, runtime.height);
  runtime.camera.updateProjectionMatrix();
  runtime.controls.maxDistance = Math.max(100, distance * 3);
  runtime.goal = { target, position: target.clone().addScaledVector(direction, distance) };
}

export default function ConversationTrail(props: TrailProps) {
  const { session, selectedTopicId, selectedTurnId, view, follow, cameraReset } = props;
  const mount = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const elements = useRef(new Map<string, HTMLButtonElement>());
  const tethers = useRef(new Map<string, SVGLineElement>());
  const heading = useRef<HTMLDivElement>(null);
  const deck = useRef<HTMLDivElement>(null);
  const branchElements = useRef(new Map<string, HTMLElement>());
  const branchTethers = useRef(new Map<string, SVGPathElement>());
  const propsRef = useRef(props);
  propsRef.current = props;
  const [expandedSuggestion, setExpandedSuggestion] = useState<string | null>(null);
  const visits = useMemo(() => buildConversationTrail(session), [session.turns, session.topics, session.turnTopics]);
  const focus = focusedVisit(visits, selectedTopicId, selectedTurnId);
  const shown = useMemo(() => visibleVisits(visits, focus, view), [visits, focus, view]);
  const decisions = useMemo(() => decisionPoints(session), [session.decisions, session.coachHistory, session.turns]);
  const decision = focusedDecision(session, focus, selectedTurnId);
  const branches = useMemo(() => nextBranches(session, focus, visits, selectedTurnId), [session.suggestions, session.decisions, session.coachHistory, focus, visits, selectedTurnId]);
  const chosenId = decision?.chosenSuggestionId ?? null;
  // Wide views retain the decision fans, so zooming out does not erase choices.
  const sceneBranches = useMemo(() => (view === 'focus' ? (focus ? [focus] : []) : shown).flatMap(visit => {
    const snapshot = visit.id === focus?.id ? decision : focusedDecision(session, visit);
    const options = visit.id === focus?.id ? branches : nextBranches(session, visit, visits);
    return options.map((branch, index) => ({ branch, visit,
      throughTurnId: snapshot?.throughTurnId ?? visit.turns.at(-1)!.id,
      chosen: branch.id === snapshot?.chosenSuggestionId,
      hasChoice: Boolean(snapshot?.chosenSuggestionId),
      end: view === 'focus' ? branchPosition(visit.position, index, options.length)
        : [visit.position[0] + 1.5 + index * 0.7, visit.position[1] + 2.6 + index * 1.6, visit.position[2] + 0.6] as Vec3,
    }));
  }), [view, shown, focus, decision, branches, session, visits]);
  const direction = decision?.direction ?? (!selectedTurnId ? session.direction : undefined);
  const latest = visits.at(-1);
  const inspecting = Boolean(focus && (focus.id !== latest?.id || (selectedTurnId && selectedTurnId !== session.turns.filter(turn => turn.final).at(-1)?.id)));
  const matchingSource = session.evidence.find(source => source.id === session.evidenceId);
  const analyzedIndex = session.turns.findIndex(turn => turn.id === session.analyzedThroughTurnId);
  const latestFinal = [...session.turns].reverse().find(turn => turn.final);
  const adviceBehind = Boolean(latestFinal && latestFinal.id !== session.analyzedThroughTurnId);
  const labels = useMemo<Label[]>(() => {
    const labelVisits = view === 'overview' && shown.length > 8
      ? [...new Map([shown[0], ...Array.from({ length: 5 }, (_, index) => shown[Math.round((index + 1) * (shown.length - 1) / 6)]), focus!, shown.at(-1)!].map(visit => [visit.id, visit])).values()]
      : shown;
    const result: Label[] = labelVisits.map(visit => ({
      id: visit.id, kind: visit.id === focus?.id ? 'turn' : 'topic', world: visit.position,
      title: visit.label,
      kicker: visit.id === latest?.id ? 'HERE · ' + formatTime(visit.turns.at(-1)!.atMs)
        : `${String(visit.index + 1).padStart(2, '0')} · ${formatTime(visit.turns[0].atMs)}`,
      detail: view === 'focus' ? (visit.id === focus?.id && selectedTurnId ? visit.turns.find(turn => turn.id === selectedTurnId)?.text : visit.turns.at(-1)!.text) : undefined,
      turnId: visit.turns.at(-1)!.id, visit, current: visit.id === focus?.id,
      priority: visit.id === focus?.id ? 100 : 65 + visit.index / Math.max(1, visits.length),
    }));
    return result.slice(0, 8);
  }, [shown, focus, latest, view, visits.length, selectedTurnId]);
  const currentRef = useRef({ labels, shown, focus, branches, sceneBranches, view });
  currentRef.current = { labels, shown, focus, branches, sceneBranches, view };
  const identity = `${session.id}:${session.generation}`;
  const knownRef = useRef<{ identity: string; visits: Set<string>; topics: Set<string> }>({ identity, visits: new Set(), topics: new Set() });

  useLayoutEffect(() => {
    const container = mount.current!;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
    camera.position.set(0, 5, 23);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'branch-scene__canvas';
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D conversation trail');
    container.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight('#d9fff3', '#19262e', 2.8));
    const light = new THREE.DirectionalLight('#c8fff1', 3);
    light.position.set(3, 10, 8);
    scene.add(light);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.minDistance = 5;
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
    const content = new THREE.Group();
    scene.add(content);
    const runtime: Runtime = { renderer, scene, camera, controls, content, pickables: [], growth: [], goal: null, manual: false, width: 1, height: 1, fit: () => {}, pulses: [] };
    runtime.fit = () => {
      const { shown, sceneBranches } = currentRef.current;
      const inset = currentRef.current.view === 'focus' && runtime.width > 620 ? (deck.current?.offsetWidth ?? 0) + 48 : 0;
      fitCamera(runtime, [...shown.map(visit => visit.position), ...sceneBranches.map(item => item.end)], inset);
    };
    runtimeRef.current = runtime;
    const resize = () => {
      runtime.width = container.clientWidth;
      runtime.height = container.clientHeight;
      renderer.setSize(runtime.width, runtime.height, false);
      camera.aspect = runtime.width / Math.max(1, runtime.height);
      camera.updateProjectionMatrix();
      if (!runtime.manual) runtime.fit();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    if (runtime.goal) {
      camera.position.copy(runtime.goal.position);
      controls.target.copy(runtime.goal.target);
      runtime.goal = null;
    }
    const probe: BranchSceneProbe = {
      ready: false, rendererCount: 1, projection: 'perspective', fov: camera.fov,
      following: propsRef.current.follow, manuallyExploring: false, activeTopicId: null, selectedTopicId: null,
      visibleLabels: [], topicPositions: {}, paths: { actual: 0, practice: 0, suggested: 0 },
      pathStyles: { actual: null, practice: null, suggested: null }, marks: [], frameIntervals: [],
      camera: { position: tuple(camera.position), target: tuple(controls.target) },
    };
    window.__branchScene = probe;
    let pointer: { x: number; y: number } | null = null;
    let dragged = false;
    const explore = () => {
      runtime.manual = true;
      runtime.goal = null;
      probe.manuallyExploring = true;
      probe.following = false;
      propsRef.current.onExplore();
    };
    const down = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; dragged = false; };
    const move = (event: PointerEvent) => {
      if (pointer && !dragged && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) { dragged = true; explore(); }
    };
    const up = (event: PointerEvent) => {
      if (pointer && !dragged && event.type !== 'pointercancel') {
        const rect = renderer.domElement.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
        const hit = ray.intersectObjects(runtime.pickables, false)[0]?.object;
        if (hit?.userData.turnId) propsRef.current.onSelectTurn(hit.userData.turnId);
      }
      pointer = null;
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', up);
    renderer.domElement.addEventListener('wheel', explore, { passive: true });
    const projected = new THREE.Vector3();
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let previous = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now > previous) probe.frameIntervals.push(now - previous);
      if (probe.frameIntervals.length > 6000) probe.frameIntervals.shift();
      previous = now;
      for (const growth of runtime.growth) {
        if (growth.settled) continue;
        const progress = reduceMotion ? 1 : Math.min(1, (now - growth.start) / GROWTH_MS);
        growth.line.geometry.setDrawRange(0, Math.max(2, Math.ceil(growth.count * (1 - (1 - progress) ** 3))));
        if (progress === 1) settleGrowth(growth, runtime);
      }
      if (runtime.goal && !runtime.manual) {
        camera.position.lerp(runtime.goal.position, reduceMotion ? 1 : 0.14);
        controls.target.lerp(runtime.goal.target, reduceMotion ? 1 : 0.14);
        if (camera.position.distanceTo(runtime.goal.position) < 0.005 && controls.target.distanceTo(runtime.goal.target) < 0.005) {
          camera.position.copy(runtime.goal.position);
          controls.target.copy(runtime.goal.target);
          runtime.goal = null;
        }
      }
      controls.update();
      camera.updateMatrixWorld();
      const candidates = currentRef.current.labels.flatMap(label => {
        const element = elements.current.get(label.id);
        if (!element) return [];
        projected.copy(vector(label.world)).project(camera);
        if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.15 || Math.abs(projected.y) > 1.15) return [];
        return [{ id: label.id, anchorX: (projected.x + 1) * runtime.width / 2, anchorY: (1 - projected.y) * runtime.height / 2,
          width: element.offsetWidth, height: element.offsetHeight, priority: label.priority,
          preferBelow: label.current && currentRef.current.view === 'focus' }];
      });
      const reserved = heading.current;
      const obstacles = [reserved, deck.current].filter((item): item is HTMLDivElement => Boolean(item)).map(item => ({ left: item.offsetLeft, top: item.offsetTop, width: item.offsetWidth, height: item.offsetHeight }));
      const placed = resolveLabelLayout(candidates, runtime.width, runtime.height, 8, 14, obstacles);
      const byId = new Map(placed.map(label => [label.id, label]));
      for (const label of currentRef.current.labels) {
        const element = elements.current.get(label.id);
        if (!element) continue;
        const placement = byId.get(label.id);
        element.style.opacity = placement ? '1' : '0';
        element.style.visibility = placement ? 'visible' : 'hidden';
        element.style.pointerEvents = placement ? 'auto' : 'none';
        if (placement) element.style.transform = `translate3d(${placement.left}px, ${placement.top}px, 0)`;
        const tether = tethers.current.get(label.id);
        if (tether) {
          tether.style.display = placement ? '' : 'none';
          if (placement) {
            const x = Math.max(placement.left + 12, Math.min(placement.left + placement.width - 12, placement.anchorX));
            const y = placement.anchorY < placement.top ? placement.top : placement.top + placement.height;
            tether.setAttribute('x1', String(x)); tether.setAttribute('y1', String(y));
            tether.setAttribute('x2', String(placement.anchorX)); tether.setAttribute('y2', String(placement.anchorY));
          }
        }
      }
      const sceneRect = container.getBoundingClientRect();
      const deckRect = deck.current?.getBoundingClientRect();
      for (const [index, branch] of currentRef.current.branches.entries()) {
        const element = branchElements.current.get(branch.id);
        const tether = branchTethers.current.get(branch.id);
        if (!element || !tether || !currentRef.current.focus || !deckRect) continue;
        const card = element.getBoundingClientRect();
        const visible = card.bottom > deckRect.top && card.top < deckRect.bottom;
        tether.style.display = visible ? '' : 'none';
        const point = vector(branchPosition(currentRef.current.focus.position, index, currentRef.current.branches.length)).project(camera);
        const x1 = (point.x + 1) * runtime.width / 2;
        const y1 = (1 - point.y) * runtime.height / 2;
        const x2 = card.left - sceneRect.left;
        const y2 = Math.max(deckRect.top + 12, Math.min(deckRect.bottom - 12, card.top + card.height / 2)) - sceneRect.top;
        tether.setAttribute('d', `M ${x1} ${y1} C ${x1 + 35} ${y1}, ${x2 - 45} ${y2}, ${x2} ${y2}`);
      }
      for (const pulse of runtime.pulses) pulse.mesh.position.copy(pulse.path.getPoint(reduceMotion ? 0.6 : (now % 2600) / 2600));
      probe.visibleLabels = placed.map(placement => ({ ...placement, kind: currentRef.current.labels.find(label => label.id === placement.id)!.kind, fontSize: 16 }));
      probe.camera = { position: tuple(camera.position), target: tuple(controls.target) };
      if (window.__branchTrail) window.__branchTrail.cameraSettled = runtime.goal === null;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      runtime.growth.forEach(growth => {
        if (growth.settleTimer !== undefined) window.clearTimeout(growth.settleTimer);
      });
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('pointercancel', up);
      renderer.domElement.removeEventListener('wheel', explore);
      controls.dispose();
      dispose(scene);
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
      delete window.__branchScene;
      delete window.__branchTrail;
    };
  }, []);

  const geometryKey = JSON.stringify({ identity, visits: shown.map(visit => [visit.id, visit.position, visit.topicId, visit.turns.at(-1)!.id, visit.practice]), focus: focus?.id,
    branches: sceneBranches.map(item => [item.branch.id, item.branch.recommended, item.throughTurnId, item.chosen, item.end]), chosenId, view });
  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const known = knownRef.current;
    const canAnimate = known.identity === identity && known.visits.size > 0;
    const priorGrowth = new Map(runtime.growth.map(growth => [growth.id, growth]));
    runtime.growth.forEach(growth => {
      if (growth.settleTimer !== undefined) window.clearTimeout(growth.settleTimer);
    });
    for (const child of [...runtime.content.children]) { dispose(child); runtime.content.remove(child); }
    runtime.pickables = [];
    runtime.growth = [];
    runtime.pulses = [];
    const styles: BranchSceneProbe['pathStyles'] = {
      actual: { material: 'LineBasicMaterial', dashed: false, dashSize: null, gapSize: null, opacity: 0.85 },
      practice: { material: 'LineDashedMaterial', dashed: true, dashSize: 0.08, gapSize: 0.13, opacity: 0.85 },
      suggested: { material: 'LineDashedMaterial', dashed: true, dashSize: 0.2, gapSize: 0.14, opacity: 0.9 },
    };
    const logicalSegments = visits.slice(1);
    const actualCount = logicalSegments.filter(visit => !visit.practice).length;
    const practiceCount = logicalSegments.filter(visit => visit.practice).length;
    const growingTopics = new Set<string>();
    const lineBetween = (from: Vec3, to: Vec3, kind: 'actual' | 'practice' | 'suggested', opacity: number) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(curve(from, to, kind === 'suggested').getPoints(48));
      const material = kind === 'actual' ? new THREE.LineBasicMaterial({ color: MINT, transparent: true, opacity })
        : new THREE.LineDashedMaterial({ color: kind === 'practice' ? PRACTICE : GOLD, dashSize: kind === 'practice' ? 0.08 : 0.2, gapSize: kind === 'practice' ? 0.13 : 0.14, transparent: true, opacity });
      const line = new THREE.Line(geometry, material);
      line.computeLineDistances();
      line.userData.kind = kind;
      runtime.content.add(line);
      styles[kind] = { material: material.type, dashed: kind !== 'actual', dashSize: material instanceof THREE.LineDashedMaterial ? material.dashSize : null,
        gapSize: material instanceof THREE.LineDashedMaterial ? material.gapSize : null, opacity };
      return line;
    };
    for (let index = 1; index < shown.length; index += 1) {
      const previous = shown[index - 1];
      const visit = shown[index];
      const kind = visit.practice ? 'practice' : 'actual';
      const line = lineBetween(previous.position, visit.position, kind, 0.85);
      const old = priorGrowth.get(visit.id);
      const animate = canAnimate && !known.visits.has(visit.id) && !growingTopics.has(visit.topicId);
      if (animate || (old && !old.settled)) {
        growingTopics.add(visit.topicId);
        const start = old?.start ?? performance.now();
        if (!old) { mark('received', visit.topicId); mark('start', visit.topicId); }
        const growth: Growth = { id: visit.id, topicId: visit.topicId, line, start, count: 49, settled: false };
        line.geometry.setDrawRange(0, 2);
        const remaining = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : Math.max(0, GROWTH_MS - (performance.now() - start));
        growth.settleTimer = window.setTimeout(() => settleGrowth(growth, runtime), remaining);
        runtime.growth.push(growth);
      }
      const path = curve(previous.position, visit.position);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.26, 8), new THREE.MeshBasicMaterial({ color: visit.practice ? PRACTICE : MINT, transparent: true, opacity: 0.9 }));
      arrow.position.copy(path.getPoint(0.62));
      arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), path.getTangent(0.62).normalize());
      runtime.content.add(arrow);
    }
    for (const visit of shown) {
      const active = visit.id === focus?.id;
      const color = visit.practice ? PRACTICE : active ? '#dbfff1' : MINT;
      const node = new THREE.Mesh(new THREE.SphereGeometry(active ? 0.2 : 0.12, 20, 16),
        new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.32, emissive: color, emissiveIntensity: active ? 0.45 : 0.08 }));
      node.position.copy(vector(visit.position));
      node.userData = { turnId: visit.turns.at(-1)!.id, topicId: visit.topicId, visitId: visit.id };
      runtime.pickables.push(node);
      runtime.content.add(node);
      if (active) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.018, 8, 64), new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity: 0.8 }));
        ring.position.copy(node.position);
        ring.rotation.x = Math.PI / 2;
        runtime.content.add(ring);
        const pool = new THREE.Mesh(new THREE.CircleGeometry(1.5, 64), new THREE.MeshBasicMaterial({ color: '#77c8b0', transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }));
        pool.position.copy(node.position).add(new THREE.Vector3(0, -0.06, 0));
        pool.rotation.x = -Math.PI / 2;
        runtime.content.add(pool);
      }
    }
    sceneBranches.forEach(({ branch, visit, end, chosen, hasChoice, throughTurnId }) => {
      const path = curve(visit.position, end, true);
      if (chosen) {
        for (const [radius, opacity] of [[0.045, 1], [0.12, 0.10]]) {
          const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 48, radius, 8, false), new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
          tube.userData.kind = 'chosen'; runtime.content.add(tube);
        }
        const spark = new THREE.Mesh(new THREE.SphereGeometry(0.095, 12, 8), new THREE.MeshBasicMaterial({ color: '#e4fff6' }));
        runtime.content.add(spark); runtime.pulses.push({ mesh: spark, path });
      } else lineBetween(visit.position, end, 'suggested', hasChoice ? 0.35 : branch.recommended ? 0.9 : 0.5);
      const node = new THREE.Mesh(new THREE.OctahedronGeometry(chosen ? 0.19 : 0.12), new THREE.MeshBasicMaterial({ color: chosen ? MINT : GOLD, wireframe: !chosen && !branch.recommended }));
      node.position.copy(vector(end));
      node.userData = { turnId: throughTurnId, topicId: branch.topicId };
      runtime.content.add(node);
      runtime.pickables.push(node);
    });
    for (const visit of shown) {
      const past = decisions.filter(item => item.chosenSuggestionId && visit.turns.some(turn => turn.id === item.throughTurnId));
      if (past.length && visit.id !== focus?.id) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.025, 8, 40), new THREE.MeshBasicMaterial({ color: MINT }));
        ring.position.copy(vector(visit.position)); ring.rotation.x = Math.PI / 2;
        runtime.content.add(ring);
      }
    }
    if (focus && view !== 'overview') {
      const grid = new THREE.GridHelper(90, 45, '#3c6b62', '#294b46');
      grid.position.set(focus.position[0], -2.8, focus.position[2]);
      (grid.material as THREE.Material).transparent = true;
      (grid.material as THREE.Material).opacity = 0.095;
      runtime.content.add(grid);
    }
    knownRef.current = { identity, visits: new Set(visits.map(visit => visit.id)), topics: new Set(visits.map(visit => visit.topicId)) };
    const probe = window.__branchScene;
    if (probe) {
      probe.ready = true;
      probe.activeTopicId = session.activeTopicId;
      probe.selectedTopicId = selectedTopicId;
      probe.topicPositions = Object.fromEntries(session.topics.map(topic => [topic.id, [...topic.position] as Vec3]));
      probe.paths = { actual: actualCount, practice: practiceCount, suggested: sceneBranches.length };
      probe.pathStyles = styles;
    }
    window.__branchTrail = { visits: visits.map(visit => ({ id: visit.id, topicId: visit.topicId, position: visit.position, turnIds: visit.turns.map(turn => turn.id), returning: visit.returning })),
      renderedVisits: shown.length, selectedVisitId: selectedTurnId ? focus?.id ?? null : null, focusedVisitId: focus?.id ?? null, branchCount: branches.length, chosenSuggestionId: chosenId, chosenPathMeshes: runtime.content.children.filter(child => child.userData.kind === 'chosen').length, decisionTurnId: decision?.throughTurnId ?? null, savedDecisions: decisions.length, view, cameraSettled: !runtime.goal };
  }, [geometryKey, decisions]);

  // Explicit navigation fits its destination even when following is paused.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.manual = false;
    runtime.fit();
    if (window.__branchScene) { window.__branchScene.manuallyExploring = false; window.__branchScene.following = follow; }
  }, [view, selectedTurnId, selectedTopicId, cameraReset]);
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (follow) { runtime.manual = false; runtime.fit(); }
    if (window.__branchScene) window.__branchScene.following = follow;
  }, [follow, focus?.id, branches.length, identity]);

  const selectVisit = (visit: TrailVisit | undefined) => { if (visit) props.onSelectTurn(focusedDecision(session, visit)?.throughTurnId ?? visit.turns.at(-1)!.id); };
  const pendingCount = session.turns.filter(turn => turn.final && !session.turnTopics[turn.id]).length;
  return <div className="conversation-trail" data-view={view} data-testid="conversation-scene">
    <div ref={mount} className="conversation-trail__viewport" />
    <div className="conversation-trail__shade" aria-hidden="true" />
    <div ref={heading} className="trail-heading">
      <span className="trail-eyebrow">{inspecting ? 'A MOMENT WORTH REVISITING' : 'EVERY CONVERSATION HAS A DIRECTION'}</span>
      <h1>{view === 'overview' ? 'The path you took.' : inspecting ? 'There was another way.' : 'Choose your next move.'}</h1>
      <button className="trail-goal" onClick={props.onEditBrief}><Target size={17} /><span><small>CALL GOAL</small><strong>{session.brief?.goal || 'Set a destination for this call'}</strong></span><ArrowRight size={15} /></button>
      {direction && <details className="trail-readiness"><summary><span className={`stage-dot stage-${direction.stage}`} />{moveLabels[direction.stage]}<span>Why this move</span></summary><p>{direction.summary}</p>{direction.established.length > 0 && <div><small>ESTABLISHED</small>{direction.established.map(item => <p key={item}><Check size={12} />{item}</p>)}</div>}{direction.blockers.length > 0 && <div><small>STILL TO RESOLVE</small>{direction.blockers.map(item => <p key={item}>{item}</p>)}</div>}</details>}
    </div>
    <svg className="trail-tethers" aria-hidden="true">{labels.map(label => <line key={label.id} ref={element => { if (element) tethers.current.set(label.id, element); else tethers.current.delete(label.id); }} stroke={label.kind === 'suggestion' ? '#d8bd7155' : '#a9ddb355'} strokeWidth="1" />)}</svg>
    {view === 'focus' && <svg className="trail-branch-tethers" aria-hidden="true">{branches.map(branch => <path key={branch.id} ref={element => { if (element) branchTethers.current.set(branch.id, element); else branchTethers.current.delete(branch.id); }} className={branch.id === chosenId ? 'is-chosen' : ''} />)}</svg>}
    {view === 'focus' && <div ref={deck} className="branch-deck" aria-label={inspecting ? 'Saved alternative paths' : 'Recommended paths'}>
      <div className="branch-deck__heading"><span><CornerDownRight size={15} />{inspecting ? 'Paths from this moment' : chosenId ? 'Your chosen direction' : 'Where to go next'}</span><small>{branches.length ? `${branches.length} paths` : 'Listening'}</small></div>
      {!branches.length && <div className="branch-deck__empty"><Sparkles size={20} /><p>{session.guidanceStatus === 'analysing' ? 'Finding the next move toward your goal…' : inspecting ? 'No recommendations were saved at this exchange. Choose a saved decision below.' : 'Next moves will appear after a completed exchange.'}</p></div>}
      {branches.map((branch, index) => <article key={`${decision?.throughTurnId}:${branch.id}`} ref={element => { if (element) branchElements.current.set(branch.id, element); else branchElements.current.delete(branch.id); }} className={`branch-option${branch.id === chosenId ? ' is-chosen' : ''}${branch.recommended ? ' is-recommended' : ''}`} data-suggestion-id={branch.id} data-intent={branch.intent ?? 'discover'} style={{ '--branch-index': index } as React.CSSProperties}>
        <button className="branch-option__inspect" aria-expanded={expandedSuggestion === branch.id} aria-label={`Explore path: ${branch.text}`} onClick={() => setExpandedSuggestion(value => value === branch.id ? null : branch.id)}>
          <span className="branch-option__meta"><span className="branch-option__number">{branch.id === chosenId ? <Check size={15} /> : `0${index + 1}`}</span><span>{branch.intent ? moveLabels[branch.intent] : branch.kind === 'response' ? 'Respond' : 'Ask'}</span><small>{branch.id === chosenId ? 'CHOSEN' : branch.recommended ? 'RECOMMENDED' : 'ALTERNATIVE'}</small></span>
          <span className="branch-option__text">{branch.text}</span>
        </button>
        {expandedSuggestion === branch.id && <p className="branch-option__reason">{branch.rationale}</p>}
        <div className="branch-option__footer"><button className="branch-option__why" onClick={() => setExpandedSuggestion(value => value === branch.id ? null : branch.id)}>{expandedSuggestion === branch.id ? 'Hide reasoning' : 'Why this move'}</button>{decision && <button className="branch-option__choose" disabled={branch.id === chosenId} onClick={() => props.onChooseBranch(decision.throughTurnId, branch.id)}>{branch.id === chosenId ? <><Check size={13} />Chosen path</> : <>{inspecting ? 'Try this alternative' : 'Choose this path'}<ArrowRight size={13} /></>}</button>}</div>
      </article>)}
      {chosenId && <p className="branch-deck__note">{inspecting ? 'Your original choice is preserved. Try an alternative in a separate practice.' : 'Chosen for your next move. Return to this moment any time to explore the alternatives.'}</p>}
    </div>}
    <div className="trail-labels" aria-label="Conversation map details">
      {labels.map(label => <button key={label.id} ref={element => { if (element) elements.current.set(label.id, element); else elements.current.delete(label.id); }}
        className={`trail-card trail-card--${label.kind}${label.current ? ' is-current' : ''}${label.recommended ? ' is-recommended' : ''}${label.visit?.practice ? ' is-practice' : ''}`}
        data-scene-label={label.id} data-label-kind={label.kind} data-turn-id={label.turnId}
        aria-label={label.kind === 'suggestion' ? `Explore question: ${label.title}` : `Moment ${label.visit!.index + 1}: ${label.title}`}
        aria-pressed={label.kind === 'suggestion' ? expandedSuggestion === label.id.slice(11) : selectedTurnId === label.turnId}
        onClick={() => {
          if (label.kind === 'suggestion') setExpandedSuggestion(value => value === label.id.slice(11) ? null : label.id.slice(11));
          else if (label.turnId) props.onSelectTurn(label.turnId);
        }}>
        <span className="trail-card__kicker">{label.kind === 'suggestion' ? <CornerDownRight size={16} /> : <i className="trail-card__dot" />}{label.visit?.practice ? 'PRACTICE · ' : ''}{label.kicker}</span>
        <span className="trail-card__title">{label.title}</span>
        {label.detail && <span className="trail-card__detail">{label.kind === 'suggestion' ? label.detail : `“${label.detail}”`}</span>}
        {label.visit?.returning && <span className="trail-card__return">↳ Revisited</span>}
        {label.current && <span className="trail-card__speaker">{label.visit!.turns.at(-1)!.speaker} · {label.visit!.turns.length} {label.visit!.turns.length === 1 ? 'exchange' : 'exchanges'}</span>}
      </button>)}
    </div>
    {!visits.length && <div className="trail-empty"><span className="trail-empty__point" /><h2>The trail starts with a conversation.</h2><p>{pendingCount ? 'Mapping the first exchanges…' : 'Press Play or start speaking to see the first moment.'}</p></div>}
    <div className="trail-status" role="status">
      {props.mapError ? <><span>Topics could not update.</span><button onClick={props.onRetry}>Retry analysis</button></> : <span>{props.mapping || pendingCount ? `Mapping ${pendingCount || 'new'} ${pendingCount === 1 ? 'exchange' : 'exchanges'}…` : session.guidanceStatus === 'error' ? 'Guidance unavailable · saved moves shown' : session.provider === 'astra' ? 'AI guidance · Astra' : 'Local preview · keyword rules'}{adviceBehind && branches.length ? ` · Earlier suggestions, through turn ${Math.max(0, analyzedIndex + 1)}` : ''}</span>}
      {matchingSource && !inspecting && <button onClick={props.onOpenSource}><BookOpen size={14} />Related source</button>}
    </div>
    {focus && <nav className="trail-navigator" aria-label="Conversation moments">
      <button aria-label="Previous moment" disabled={focus.index === 0} onClick={() => selectVisit(visits[focus.index - 1])}><ArrowLeft size={17} /></button>
      <label><span>Moment</span><select aria-label="Jump to conversation moment" value={focus.id} onChange={event => selectVisit(visits.find(visit => visit.id === event.target.value))}>{visits.map(visit => <option key={visit.id} value={visit.id}>{visit.index + 1} · {visit.label}{visit.returning ? ' (revisited)' : ''}</option>)}</select><span>of {visits.length}</span></label>
      {decisions.length > 0 && <label className="decision-history"><History size={14} /><select aria-label="Revisit saved paths" value={decision?.throughTurnId ?? ''} onChange={event => { if (event.target.value) props.onSelectTurn(event.target.value); }}><option value="" disabled>Saved paths</option>{decisions.map(item => { const turn = session.turns.find(turn => turn.id === item.throughTurnId)!; const chosen = item.suggestions.find(suggestion => suggestion.id === item.chosenSuggestionId); return <option key={item.throughTurnId} value={item.throughTurnId}>{formatTime(turn.atMs)} · {chosen ? `Chose ${chosen.intent ? moveLabels[chosen.intent] : 'a path'}` : `${item.suggestions.length} alternatives`}</option>; })}</select></label>}
      <button aria-label="Next moment" disabled={focus.index === visits.length - 1} onClick={() => selectVisit(visits[focus.index + 1])}><ArrowRight size={17} /></button>
    </nav>}
  </div>;
}
