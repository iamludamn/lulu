import Foundation

public struct SkyWeather: Codable, Equatable, Sendable {
    public let city: String
    public let timezone: String
    public let fetchedAt: Date
    public let observedAt: Date
    public let code: Int
    public let cloudCover: Double
    public let sunrise: Date?
    public let sunset: Date?
    public let isDay: Bool

    public enum Mood: String, Sendable { case day, dusk, rain, night }

    public func usable(at now: Date) -> Bool {
        (0...10800).contains(now.timeIntervalSince(observedAt)) &&
        (0...10800).contains(now.timeIntervalSince(fetchedAt))
    }

    public func mood(at now: Date) -> Mood {
        let wet = (51...86).contains(code) || (95...99).contains(code)
        if let sunrise, let sunset, sunset > sunrise {
            if now < sunrise || now > sunset.addingTimeInterval(1800) { return .night }
            if !wet && now > sunset.addingTimeInterval(-2700) { return .dusk }
        } else if !isDay { return .night }
        return wet ? .rain : .day
    }

    private struct Places: Decodable {
        struct Place: Decodable { let name: String; let latitude: Double; let longitude: Double }
        let results: [Place]?
    }
    private struct Response: Decodable {
        struct Current: Decodable { let time: Double; let weather_code: Int; let cloud_cover: Double; let is_day: Int }
        struct Daily: Decodable { let sunrise: [Double?]; let sunset: [Double?] }
        let timezone: String
        let current: Current
        let daily: Daily
    }

    public static func load(city: String, defaults: UserDefaults = .standard) async -> SkyWeather? {
        let city = city.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !city.isEmpty else { return nil }
        let key = "lulu.sky.v1.\(city.lowercased())"
        let cached = defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
        if let cached, cached.usable(at: .now), Date.now.timeIntervalSince(cached.fetchedAt) < 1200 { return cached }
        do {
            var search = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
            search.queryItems = [.init(name: "name", value: city), .init(name: "count", value: "1"), .init(name: "language", value: "zh")]
            let places = try JSONDecoder().decode(Places.self, from: await data(search.url!))
            guard let place = places.results?.first else { return nil }
            var query = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
            query.queryItems = [
                .init(name: "latitude", value: String(place.latitude)), .init(name: "longitude", value: String(place.longitude)),
                .init(name: "current", value: "weather_code,cloud_cover,is_day"),
                .init(name: "daily", value: "sunrise,sunset"), .init(name: "forecast_days", value: "1"),
                .init(name: "timezone", value: "auto"), .init(name: "timeformat", value: "unixtime")
            ]
            let raw = try JSONDecoder().decode(Response.self, from: await data(query.url!))
            let fresh = Self(city: place.name, timezone: raw.timezone, fetchedAt: .now,
                             observedAt: Date(timeIntervalSince1970: raw.current.time), code: raw.current.weather_code,
                             cloudCover: raw.current.cloud_cover,
                             sunrise: raw.daily.sunrise.first.flatMap { $0 }.map { Date(timeIntervalSince1970: $0) },
                             sunset: raw.daily.sunset.first.flatMap { $0 }.map { Date(timeIntervalSince1970: $0) }, isDay: raw.current.is_day == 1)
            guard fresh.usable(at: .now) else { return nil }
            defaults.set(try JSONEncoder().encode(fresh), forKey: key)
            return fresh
        } catch {
            return cached.flatMap { $0.usable(at: .now) ? $0 : nil }
        }
    }

    private static func data(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else { throw URLError(.badServerResponse) }
        return data
    }
}
