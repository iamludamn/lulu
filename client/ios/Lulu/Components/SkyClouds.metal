#include <metal_stdlib>
using namespace metal;

float skyHash(float2 p) {
    return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

float skyNoise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(skyHash(i), skyHash(i + float2(1, 0)), f.x),
               mix(skyHash(i + float2(0, 1)), skyHash(i + float2(1, 1)), f.x), f.y);
}

float skyField(float2 p) {
    return skyNoise(p) * 0.62 + skyNoise(p * 2.03 + 17.1) * 0.27 + skyNoise(p * 4.01 + 9.2) * 0.11;
}

[[ stitchable ]] half4 skyClouds(float2 position, half4 source, float2 size, float mood, float cover, float dark) {
    float2 uv = position / size;
    float2 p = float2(uv.x * 2.7, uv.y * 5.1);
    p.x += p.y * 0.65;
    float2 warp = float2(skyField(p * 0.65 + 7.3), skyField(p * 0.65 + 23.7));
    float field = skyField(p + warp * 1.15 + float2(3.1, 8.7));
    float veil = smoothstep(0.25, 0.78, field);
    float detail = skyNoise(p * 7.0 + warp * 2.0);
    veil = clamp(veil + (detail - 0.5) * 0.035, 0.0, 1.0);
    float3 top = float3(0.36, 0.54, 0.71);
    float3 bottom = float3(0.56, 0.71, 0.84);
    float3 cloud = float3(0.79, 0.87, 0.94);
    float strength = 0.62 + cover * 0.0015;
    if (mood > 2.5) {
        top = float3(0.065, 0.12, 0.21);
        bottom = float3(0.14, 0.25, 0.37);
        cloud = float3(0.39, 0.55, 0.69);
        strength = 0.65;
    } else if (mood > 1.5) {
        top = float3(0.37, 0.47, 0.57);
        bottom = float3(0.53, 0.64, 0.73);
        cloud = float3(0.76, 0.82, 0.87);
        strength = 0.74;
    } else if (mood > 0.5) {
        top = float3(0.28, 0.38, 0.49);
        bottom = float3(0.52, 0.56, 0.65);
        cloud = float3(0.72, 0.68, 0.76);
    }
    float3 rgb = mix(mix(top, bottom, uv.y), cloud, veil * strength);
    if (mood > 0.5 && mood < 1.5) {
        float band = uv.y + uv.x * 0.26 - 0.75 + (field - 0.5) * 0.17;
        float warmth = exp(-band * band / 0.013) * (0.6 + veil * 0.4);
        rgb = mix(rgb, float3(0.98, 0.62, 0.57), warmth * 0.77);
    }
    if (dark > 0.5 && mood < 2.5) { rgb *= 0.53; }
    if (dark < 0.5 && mood > 2.5) { rgb = mix(rgb, float3(0.86, 0.9, 0.94), 0.48); }
    return half4(half3(rgb), 1.0);
}
