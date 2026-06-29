export interface AugConfig {
  flip_enabled: boolean

  brightness_enabled: boolean
  brightness_steps: number
  brightness_magnitude_pct: number

  contrast_enabled: boolean
  contrast_steps: number
  contrast_magnitude_pct: number

  rotation_enabled: boolean
  rotation_steps: number
  rotation_max_angle_deg: number

  pixel_quality_enabled: boolean
  pixel_quality_steps: number
  pixel_quality_min_scale: number
}

export const DEFAULT_AUG_CONFIG: AugConfig = {
  flip_enabled: true,
  brightness_enabled: true,
  brightness_steps: 2,
  brightness_magnitude_pct: 20,
  contrast_enabled: true,
  contrast_steps: 2,
  contrast_magnitude_pct: 20,
  rotation_enabled: true,
  rotation_steps: 4,
  rotation_max_angle_deg: 20,
  pixel_quality_enabled: true,
  pixel_quality_steps: 3,
  pixel_quality_min_scale: 0.4,
}
