<script lang="ts" setup>
// Link previews for every docs page, in the landing's night style. Rendered at build time (1200×630).
const props = withDefaults(defineProps<{ title?: string, description?: string, headline?: string }>(), {
  title: 'Vigie',
  description: '',
})

const title = (props.title || '').slice(0, 60)
const description = (props.description || '').slice(0, 170)
</script>

<template>
  <div
    style="width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: space-between; align-items: stretch; background: linear-gradient(160deg, #0b1324 0%, #0d1830 55%, #13233d 100%); padding: 96px 80px 0 80px; font-family: Geist;"
  >
    <div style="display: flex; flex-direction: column; align-items: flex-start; gap: 20px; margin-top: 8px;">
      <span
        v-if="headline"
        style="font-size: 24px; color: #d4f27a; letter-spacing: 1px; text-transform: uppercase;"
      >{{ headline }}</span>
      <div style="font-family: 'Funnel Display'; font-size: 76px; font-weight: 600; line-height: 1.02; letter-spacing: -1.5px; color: #f8fafc; max-width: 980px;">
        {{ title }}
      </div>
      <div
        v-if="description"
        style="font-size: 30px; line-height: 1.35; color: #a9b8cc; max-width: 960px;"
      >
        {{ description }}
      </div>
    </div>

    <div style="display: flex; flex-direction: column; gap: 10px; padding-bottom: 56px; width: 100%;">
      <div style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; width: 100%;">
        <span style="display: flex; flex-direction: row; align-items: center; gap: 14px;">
          <svg width="40" height="40" viewBox="0 0 22 22">
            <rect width="22" height="22" rx="6.5" fill="#D9685C" />
            <circle cx="11" cy="11" r="5.2" fill="none" stroke="#fff" stroke-width="1.7" />
            <circle cx="11" cy="11" r="1.9" fill="#fff" />
          </svg>
          <span style="font-family: 'Funnel Display'; font-size: 32px; font-weight: 600; color: #f1f5f9;">Vigie</span>
          <span style="font-size: 22px; color: #7f8ea6; margin-left: 10px;">Self-hosted telemetry for Node apps</span>
        </span>
        <span style="font-size: 22px; color: #d9685c;">vigie.chronicstone.dev</span>
      </div>
    </div>
  </div>
</template>
