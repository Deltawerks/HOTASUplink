// The packager and desktop process also use this list, without loading the 3D renderer.
export const defaultRigId = 'vkb-gladiator-evo-omni';
export const modelAssetsByRig = {
  [defaultRigId]: {
    left: new URL('../../assets/rig/left.glb', import.meta.url).href,
    right: new URL('../../assets/rig/right.glb', import.meta.url).href,
    sem: new URL('../../assets/rig/sem.glb', import.meta.url).href,
  },
};
