#include <metal_stdlib>
using namespace metal;

[[ stitchable ]] float2 voiceCloudFlow(float2 position, float2 size, float time, float level) {
    float2 uv = position / size;
    float t = time * 0.22;
    float2 drift = float2(
        sin(uv.y * 8.0 + t) + 0.45 * sin(uv.x * 11.0 - uv.y * 5.0 + t * 0.7),
        cos(uv.x * 7.0 - t * 0.8) + 0.45 * sin(uv.y * 10.0 + uv.x * 4.0 + t)
    );
    float edge = sin(M_PI_F * uv.x) * sin(M_PI_F * uv.y);
    return position + drift * (7.0 + level * 5.0) * edge;
}

[[ stitchable ]] half4 voiceLightRings(float2 position, half4 color, float2 size, float time, float level) {
    float2 delta = position - size * float2(0.5, 0.44);
    float radius = length(delta);
    float angle = atan2(delta.y, delta.x);
    float alpha = 0.0;
    const float radii[4] = {0.19, 0.275, 0.37, 0.455};
    for (int i = 0; i < 4; i++) {
        float phase = time * 0.65 - float(i) * 0.6;
        float ripple = sin(angle * 3.0 + time * 2.2 - float(i) * 0.7);
        float r = size.x * (radii[i] + 0.004 * sin(phase)
            + level * (0.028 + float(i) * 0.009 + 0.009 * ripple));
        float distance = radius - r;
        float brokenLight = 0.63 + 0.22 * sin(angle * 2.0 + phase * 0.3) + 0.15 * cos(angle * 3.0 - phase * 0.2);
        float line = exp(-distance * distance / (0.75 + level * 1.7));
        float halo = exp(-distance * distance / (12.0 + level * 24.0));
        alpha += (line * 0.115 + halo * 0.018) * brokenLight * (1.0 - float(i) * 0.13) * (0.8 + level * 2.7);
    }
    float glow = exp(-radius * radius / (size.x * size.x * 0.035));
    alpha += glow * level * 0.20;
    return half4(half3(0.91h, 0.99h, 1.0h) * half(alpha), half(alpha));
}
