#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <string_view>
#include <unistd.h>

struct Vector3 {
    float x;
    float y;
    float z;
};

struct ParticleStats {
    double kinetic_energy = 0;
    double temperature = 0;
    double visible_area = 0;
    double rotation = 0;
    std::uint32_t color_checksum = 0;
    unsigned bounces = 0;
    unsigned respawns = 0;
};

class Particle {
public:
    void emit(unsigned id) {
        id_ = id;
        generation_ = 0;
        bounces_ = 0;
        reset();
    }

    void update(float dt) {
        age_ += dt;
        if (age_ >= lifetime_) {
            ++generation_;
            reset();
        }

        const float damping = std::max(0.0f, 1.0f - drag_ * dt / mass_);
        velocity_.x = (velocity_.x + acceleration_.x * dt) * damping;
        velocity_.y = (velocity_.y + acceleration_.y * dt) * damping;
        velocity_.z = (velocity_.z + acceleration_.z * dt) * damping;
        position_.x += velocity_.x * dt;
        position_.y += velocity_.y * dt;
        position_.z += velocity_.z * dt;

        if (position_.y < 0.0f) {
            position_.y = 0.0f;
            velocity_.y *= -restitution_;
            ++bounces_;
        }

        const float life_left = 1.0f - age_ / lifetime_;
        temperature_ = std::max(20.0f, temperature_ - cooling_rate_ * dt);
        rotation_ += angular_velocity_ * dt;
        size_ = initial_size_ * (0.5f + 0.5f * life_left);
        opacity_ = life_left;
        const auto red = static_cast<std::uint32_t>(std::min(temperature_, 255.0f));
        const auto alpha = static_cast<std::uint32_t>(opacity_ * 255.0f);
        color_ = (alpha << 24) | (red << 16) | 0x6030u;
    }

    void add_to(ParticleStats& stats) const {
        const float speed_squared = velocity_.x * velocity_.x + velocity_.y * velocity_.y + velocity_.z * velocity_.z;
        stats.kinetic_energy += 0.5 * mass_ * speed_squared;
        stats.temperature += temperature_;
        stats.visible_area += size_ * size_ * opacity_;
        stats.rotation += rotation_;
        stats.color_checksum += color_;
        stats.bounces += bounces_;
        stats.respawns += generation_;
    }

private:
    void reset() {
        const unsigned variation = id_ + generation_;
        const float spread = static_cast<float>(variation % 9) - 4.0f;
        position_ = {spread * 0.2f, 0.5f, 0.0f};
        velocity_ = {spread * 0.3f, 4.0f + (variation % 5) * 0.4f, -spread * 0.16f};
        acceleration_ = {0.06f * spread, -9.81f, 0.03f};
        age_ = 0.0f;
        lifetime_ = 3.0f + (variation % 7) * 0.25f;
        mass_ = 0.5f + (id_ % 8) * 0.15f;
        drag_ = 0.15f + (id_ % 5) * 0.04f;
        restitution_ = 0.5f + (id_ % 5) * 0.06f;
        temperature_ = 320.0f + (variation % 11) * 9.0f;
        cooling_rate_ = 17.0f + (id_ % 5) * 3.0f;
        initial_size_ = 0.08f + (id_ % 6) * 0.025f;
        size_ = initial_size_;
        opacity_ = 1.0f;
        rotation_ = 0.0f;
        angular_velocity_ = spread * 0.45f;
        color_ = 0xffff6030u;
    }

    Vector3 position_, velocity_, acceleration_;
    float age_, lifetime_, mass_, drag_, restitution_;
    float temperature_, cooling_rate_, initial_size_, size_, opacity_, rotation_, angular_velocity_;
    std::uint32_t color_;
    unsigned id_, generation_, bounces_;
};

class ParticleSystem {
public:
    static constexpr std::size_t capacity = 48;

    void emit(std::size_t first, std::size_t last) {
        for (std::size_t index = first; index < last; ++index) {
            particles_[index].emit(static_cast<unsigned>(index));
        }
    }

    void update(std::size_t active, float dt) {
        for (std::size_t index = 0; index < active; ++index) particles_[index].update(dt);
    }

    ParticleStats stats(std::size_t active) const {
        ParticleStats result;
        for (std::size_t index = 0; index < active; ++index) particles_[index].add_to(result);
        return result;
    }

private:
    std::array<Particle, capacity> particles_;
};

// Keep a named symbol for selecting the particle buffer in the trace viewer.
extern "C" {
ParticleSystem particle_system;
}

int main(int argc, char** argv) {
    int steps = 300;
    if (argc == 2) {
        const std::string_view input = argv[1];
        const auto result = std::from_chars(input.data(), input.data() + input.size(), steps);
        if (result.ec != std::errc{} || result.ptr != input.data() + input.size() || steps < 1) steps = 0;
    }
    if (argc > 2 || steps == 0) {
        std::fprintf(stderr, "Usage: %s [positive step count]\n", argv[0]);
        return 2;
    }

    constexpr float dt = 0.1f;
    constexpr std::array<std::size_t, 3> active_counts{12, 24, ParticleSystem::capacity};
    std::size_t active = 0;
    for (int step = 0; step < steps; ++step) {
        const std::size_t next = active_counts[std::min(step / 100, 2)];
        if (next != active) {
            particle_system.emit(active, next);
            active = next;
        }
        particle_system.update(active, dt);
        usleep(100000);
    }

    const auto stats = particle_system.stats(active);
    std::printf("particles=%zu steps=%d energy=%.3f average_temperature=%.1f visible_area=%.3f average_rotation=%.3f "
                "bounces=%u respawns=%u color_checksum=%08x\n",
                active, steps, stats.kinetic_energy, stats.temperature / active, stats.visible_area, stats.rotation / active,
                stats.bounces, stats.respawns, stats.color_checksum);
}
