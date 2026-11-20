#pragma once

#include <cmath>

namespace nbody {

struct Vec3 {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

static_assert(sizeof(Vec3) == 3 * sizeof(double), "Vec3 must have no padding");

constexpr Vec3 operator+(const Vec3& a, const Vec3& b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
constexpr Vec3 operator-(const Vec3& a, const Vec3& b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
constexpr Vec3 operator*(double s, const Vec3& v) { return {s * v.x, s * v.y, s * v.z}; }

constexpr Vec3& operator+=(Vec3& a, const Vec3& b) {
    a = a + b;
    return a;
}

constexpr double dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

inline bool is_finite(const Vec3& v) {
    return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z);
}

}  // namespace nbody
