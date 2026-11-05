import type { FrameState, Renderer, Scene, Target } from '../../gl/renderer';
import { TunnelCheese } from './cheese';
import { TunnelOriginal } from './original';
import { TunnelPaths } from './paths';

// The tunnel keeps its earlier versions side by side. Only "cheese" is shown; the others
// stay reachable for development with ?tunnel=original or ?tunnel=paths.

export const TUNNEL_VERSIONS = ['original', 'cheese', 'paths'] as const;
export type TunnelVersion = (typeof TUNNEL_VERSIONS)[number];

export class TunnelScene implements Scene {
  readonly id = 'tunnel';
  readonly scale = 1;
  version = TUNNEL_VERSIONS.indexOf('cheese');
  private readonly versions: Scene[] = [new TunnelOriginal(), new TunnelCheese(), new TunnelPaths()];

  init(r: Renderer) {
    this.versions.forEach((v) => v.init(r));
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    this.versions[this.version].render(r, frame, target);
  }
}
