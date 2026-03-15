/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion } from "motion/react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useRef, useMemo, Suspense, useEffect } from "react";
import * as THREE from "three";
import { MeshTransmissionMaterial, Environment, Float } from "@react-three/drei";
import { EffectComposer, ChromaticAberration, Noise } from "@react-three/postprocessing";

// --- Shaders ---

const fluidVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fluidFragmentShader = `
  uniform float uTime;
  uniform vec2 uMouse;
  uniform vec2 uVelocity;
  uniform vec2 uResolution;
  uniform float uFrequency;
  uniform float uAmplitude;
  uniform float uSpeed;
  uniform float uMouseRadius;
  varying vec2 vUv;

  // Simplex 2D noise
  vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
             -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy) );
    vec2 x0 = v -   i + dot(i, C.xx);
    vec2 i1;
    i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 ))
    + i.x + vec3(0.0, i1.x, 1.0 ));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy),
      dot(x12.zw,x12.zw)), 0.0);
    m = m*m ;
    m = m*m ;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 a0 = x - floor(x + 0.5);
    vec3 m1 = 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec2 uv = vUv;
    float ratio = uResolution.x / uResolution.y;
    vec2 centeredUv = (uv - 0.5) * vec2(ratio, 1.0);
    
    // --- Mouse Interaction (Displacement Field) ---
    vec2 mousePos = uMouse * vec2(ratio, 1.0);
    float dist = distance(centeredUv, mousePos);
    float influence = smoothstep(uMouseRadius, 0.0, dist);
    
    // Create a displacement vector based on mouse velocity and distance
    vec2 displacement = uVelocity * influence * 2.5;
    
    // --- Organic Noise (Idle + Interaction) ---
    float time = uTime * uSpeed;
    
    // Layered noise for fluid movement
    vec2 noiseUv = centeredUv * uFrequency - displacement;
    float n = snoise(noiseUv + time * 0.1);
    n += 0.5 * snoise(noiseUv * 2.0 - time * 0.15);
    n += 0.25 * snoise(noiseUv * 4.0 + time * 0.2);
    
    // Apply displacement to UVs for the final look
    vec2 finalUv = centeredUv + displacement + n * uAmplitude;
    
    // Recalculate noise for color mapping
    float colorNoise = snoise(finalUv * uFrequency + time * 0.05);
    colorNoise += 0.4 * snoise(finalUv * uFrequency * 2.2 - time * 0.1);
    
    // --- Jet Black Color Palette (Blue Base) ---
    vec3 darkBlue = vec3(0.0, 0.001, 0.004);
    vec3 deepBlue = vec3(0.01, 0.02, 0.04);
    vec3 cyan = vec3(0.02, 0.05, 0.1);
    vec3 highlight = vec3(0.05, 0.1, 0.18); // Muted cyan/blue
    
    vec3 color = mix(darkBlue, deepBlue, smoothstep(-0.8, 0.4, colorNoise));
    color = mix(color, cyan, smoothstep(0.2, 0.8, colorNoise));
    color = mix(color, highlight, smoothstep(0.7, 1.3, colorNoise));
    
    // Subtle glow at mouse (Blue)
    color += influence * highlight * (0.03 + length(uVelocity) * 1.5);
    
    // Strong Vignette for Jet Black feel
    float vignette = smoothstep(1.1, 0.2, length(centeredUv));
    color *= vignette;
    
    gl_FragColor = vec4(color, 1.0);
  }
`;

// --- Components ---

function FluidBackground() {
  const meshRef = useRef<THREE.Mesh>(null);
  const { size, viewport } = useThree();
  const prevMouse = useRef(new THREE.Vector2(0, 0));
  const velocity = useRef(new THREE.Vector2(0, 0));
  
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uMouse: { value: new THREE.Vector2(0, 0) },
    uVelocity: { value: new THREE.Vector2(0, 0) },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
    uFrequency: { value: 1.8 },
    uAmplitude: { value: 0.04 },
    uSpeed: { value: 0.15 },
    uMouseRadius: { value: 0.4 }
  }), []);

  useFrame((state) => {
    if (meshRef.current) {
      const material = meshRef.current.material as THREE.ShaderMaterial;
      material.uniforms.uTime.value = state.clock.getElapsedTime();
      
      // Target mouse position with easing
      const targetMouse = new THREE.Vector2(state.mouse.x * 0.5, state.mouse.y * 0.5);
      material.uniforms.uMouse.value.lerp(targetMouse, 0.05);
      
      // Calculate velocity for viscous effect
      velocity.current.subVectors(material.uniforms.uMouse.value, prevMouse.current);
      material.uniforms.uVelocity.value.lerp(velocity.current, 0.1);
      
      prevMouse.current.copy(material.uniforms.uMouse.value);
      material.uniforms.uResolution.value.set(size.width, size.height);
    }
  });

  return (
    <mesh ref={meshRef} position={[0, 0, 0]} scale={[viewport.width, viewport.height, 1]}>
      <planeGeometry args={[1, 1]} />
      <shaderMaterial
        vertexShader={fluidVertexShader}
        fragmentShader={fluidFragmentShader}
        uniforms={uniforms}
        depthWrite={false}
        depthTest={true}
      />
    </mesh>
  );
}

// --- Rim Light Shader ---
const rimVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewPosition = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const rimFragmentShader = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vViewPosition), 0.0), 3.5);
    gl_FragColor = vec4(1.0, 1.0, 1.0, fresnel * 0.9);
  }
`;

const sphereShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor1: { value: new THREE.Color("#0e1a20") }, // Deep Metallic Blue
    uColor2: { value: new THREE.Color("#00050d") }, // Deep Navy/Black
  },
  vertexShader: `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewPosition;
    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vViewPosition = -mvPosition.xyz;
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor1;
    uniform vec3 uColor2;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

    // Simplex-like noise for organic flow
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f*f*(3.0-2.0*f);
        return mix(mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), f.x),
                   mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
    }

    void main() {
      vec3 viewDir = normalize(vViewPosition);
      float fresnel = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 3.0);
      
      // Oil-on-water distortion logic
      vec2 uv = vUv * 2.5;
      float t = uTime * 0.15;
      
      float n = noise(uv + vec2(t, t * 0.6));
      n = noise(uv + n * 1.5 + vec2(t * 0.4, -t * 0.2));
      n = noise(uv + n * 2.0 + t * 0.1);
      
      // Flowing Gradient
      vec3 color = mix(uColor1, uColor2, n);
      
      // Metallic Specular - Tinted gold instead of pure white
      float spec = pow(max(dot(vNormal, normalize(vec3(1.0, 1.0, 1.0))), 0.0), 40.0);
      color += spec * vec3(0.5, 0.4, 0.2);
      
      // Fine Grain / Particles
      float grain = (hash(gl_FragCoord.xy * 0.5 + uTime) - 0.5) * 0.04;
      color += grain;
      
      // Soft Iridescent Luster - Muted
      vec3 irid = 0.5 + 0.5 * cos(vec3(0, 2, 4) + n * 4.0 + uTime * 0.2);
      color = mix(color, irid * 0.3, fresnel * 0.5);
      
      gl_FragColor = vec4(color, 1.0);
    }
  `
};

function RefractingSphere() {
  const meshRef = useRef<THREE.Mesh>(null);
  const flowRef = useRef<THREE.Mesh>(null);
  const rimRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  const { viewport } = useThree();
  
  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = t;
    }
    if (meshRef.current && flowRef.current && rimRef.current) {
      const targetX = -viewport.width * 0.15;
      const targetY = viewport.height * 0.15;
      
      meshRef.current.position.set(targetX, targetY, 2);
      flowRef.current.position.set(targetX, targetY, 2.01);
      rimRef.current.position.set(targetX, targetY, 2.05);
      
      meshRef.current.rotation.y = t * 0.05;
      flowRef.current.rotation.y = t * 0.05;
    }
  });

  const sphereScale = Math.min(viewport.width, viewport.height) * 0.5;

  return (
    <>
      {/* Layer 1: The "Transparent Mass" (Refraction & Distortion) */}
      <mesh ref={meshRef} scale={sphereScale}>
        <sphereGeometry args={[1, 64, 64]} />
        <MeshTransmissionMaterial
          backside
          samples={16}
          thickness={2.0}
          ior={1.4}
          chromaticAberration={0.4}
          distortion={0.8}
          distortionScale={0.6}
          temporalDistortion={0.1}
          transmission={1}
          roughness={0.08}
          color="#1a1a20"
        />
      </mesh>

      {/* Layer 2: The Metallic Flow (Overlay with Transparency) */}
      <mesh ref={flowRef} scale={sphereScale * 0.99}>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
          ref={materialRef}
          transparent
          opacity={0.6}
          uniforms={THREE.UniformsUtils.clone(sphereShader.uniforms)}
          vertexShader={sphereShader.vertexShader}
          fragmentShader={sphereShader.fragmentShader.replace(
            'gl_FragColor = vec4(color, 1.0);',
            'gl_FragColor = vec4(color, 0.4);'
          )}
          blending={THREE.NormalBlending}
        />
      </mesh>

      {/* Layer 3: Rim Glow with Chromatic Aberration */}
      <mesh ref={rimRef} scale={sphereScale * 1.02}>
        <sphereGeometry args={[1, 64, 64]} />
        <shaderMaterial
          vertexShader={rimVertexShader}
          fragmentShader={`
            varying vec3 vNormal;
            varying vec3 vViewPosition;
            void main() {
              vec3 viewDir = normalize(vViewPosition);
              // Chromatic Aberration: Shift fresnel for R, G, B
              float r = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.2);
              float g = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.5);
              float b = pow(1.0 - max(dot(vNormal, viewDir), 0.0), 2.8);
              
              // Combine with a very subtle blue/cyan tint
              vec3 rimColor = vec3(r * 0.1, g * 0.3, b * 0.5);
              gl_FragColor = vec4(rimColor, g * 0.6);
            }
          `}
          transparent
          blending={THREE.AdditiveBlending}
          depthTest={false}
        />
      </mesh>
    </>
  );
}

export default function App() {
  const navItems = ["WORK", "MANIFESTO", "SAIGON SOULS", "TEAM", "CONTACT"];
  const languages = ["I", "EN", "VN", "中文"];
  const cursorRef = useRef<HTMLDivElement>(null);

  // Custom cursor logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (cursorRef.current) {
        // Smooth cursor follow
        cursorRef.current.animate({
          transform: `translate3d(${e.clientX}px, ${e.clientY}px, 0)`
        }, { duration: 500, fill: "forwards" });
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <div className="relative min-h-screen bg-black text-white font-sans overflow-hidden selection:bg-white selection:text-black cursor-none">
      {/* Custom Cursor Dot */}
      <div 
        ref={cursorRef}
        className="fixed top-0 left-0 w-2 h-2 bg-white rounded-full z-[100] pointer-events-none -ml-1 -mt-1 mix-blend-difference"
      />

      {/* R3F Background */}
      <div className="fixed inset-0 z-0">
        <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
          <Suspense fallback={null}>
            <FluidBackground />
            <RefractingSphere />
            {/* Environment removed to delete "images" inside the sphere */}
            <EffectComposer>
              <Noise opacity={0.12} />
              <ChromaticAberration offset={new THREE.Vector2(0.002, 0.002)} />
            </EffectComposer>
          </Suspense>
        </Canvas>
      </div>

      {/* Header */}
      <header className="fixed top-0 left-0 w-full p-8 md:p-12 flex justify-between items-start z-50">
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="flex items-baseline gap-2"
        >
          <span className="text-xl font-bold tracking-tighter uppercase">monopo</span>
          <span className="text-xs opacity-60 tracking-widest uppercase">saigon</span>
        </motion.div>

        <div className="flex flex-col items-end gap-8">
          {/* Language Switcher */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 1 }}
            className="flex gap-4 text-[10px] tracking-[0.2em] font-medium"
          >
            {languages.map((lang, i) => (
              <button 
                key={lang} 
                className={`hover:opacity-100 transition-opacity ${i === 1 ? 'opacity-100' : 'opacity-40'}`}
              >
                {lang}
              </button>
            ))}
          </motion.div>

          {/* Navigation */}
          <nav className="hidden md:flex flex-col items-end gap-3">
            {navItems.map((item, i) => (
              <motion.a
                key={item}
                href={`#${item.toLowerCase().replace(' ', '-')}`}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.6 + i * 0.1, duration: 0.8 }}
                className="text-[11px] tracking-[0.25em] font-medium opacity-60 hover:opacity-100 transition-opacity"
              >
                {item}
              </motion.a>
            ))}
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 flex items-center justify-center min-h-screen px-6 pointer-events-none">
        <motion.h1 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
          className="text-4xl md:text-6xl lg:text-8xl font-medium tracking-tight text-center max-w-5xl leading-[1.1] drop-shadow-2xl"
        >
          United, Unbound
        </motion.h1>
      </main>

      {/* Footer / Scroll Indicator */}
      <footer className="fixed bottom-0 left-0 w-full p-8 md:p-12 flex justify-between items-end pointer-events-none z-50">
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 1 }}
          className="relative w-24 h-24 pointer-events-auto cursor-pointer group"
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-8 h-12 border border-white/30 rounded-full flex justify-center p-1">
              <motion.div 
                animate={{ y: [0, 15, 0] }}
                transition={{ repeat: Infinity, duration: 1.5 }}
                className="w-1.5 h-1.5 bg-white rounded-full"
              />
            </div>
          </div>
          
          {/* Circular Text SVG */}
          <svg viewBox="0 0 100 100" className="w-full h-full animate-spin-slow opacity-40 group-hover:opacity-100 transition-opacity">
            <path
              id="circlePath"
              d="M 50, 50 m -37, 0 a 37,37 0 1,1 74,0 a 37,37 0 1,1 -74,0"
              fill="transparent"
            />
            <text className="text-[8px] uppercase tracking-[0.3em] fill-white">
              <textPath xlinkHref="#circlePath">
                SCROLL DOWN • SCROLL DOWN • 
              </textPath>
            </text>
          </svg>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.8, duration: 1 }}
          className="w-12 h-1.5 bg-white/10 rounded-full overflow-hidden"
        >
          <motion.div 
            animate={{ x: [-48, 48] }}
            transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
            className="w-1/2 h-full bg-white/40"
          />
        </motion.div>
      </footer>

      {/* Background Subtle Grain/Texture (Overlay) */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.05] bg-[url('https://grainy-gradients.vercel.app/noise.svg')] z-20"></div>
    </div>
  );
}
