import Foundation

public struct Forecast: Codable, Equatable, Sendable {
    public struct Day: Codable, Equatable, Sendable {
        public let date: Date
        public let code: Int
        public let high: Double
        public let low: Double
    }

    public let city: String
    public let day: String
    public let temperature: Double
    public let code: Int
    public let days: [Day]
}

public enum Weather {
    public static func forecast(city: String) async -> Forecast? {
        let key = "pistack.weather.\(city)"
        let cached = UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(Forecast.self, from: $0) }
        if let cached, cached.day == today { return cached }
        guard let fresh = try? await fetch(city) else { return cached }
        UserDefaults.standard.set(try? JSONEncoder().encode(fresh), forKey: key)
        return fresh
    }

    private static var today: String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: .now)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }

    private struct Geocoding: Decodable {
        struct Place: Decodable {
            let name: String
            let latitude: Double
            let longitude: Double
        }

        let results: [Place]?
    }

    private struct Raw: Decodable {
        struct Current: Decodable {
            let temperature: Double
            let code: Int

            private enum CodingKeys: String, CodingKey { case temperature = "temperature_2m", code = "weather_code" }
        }

        struct Daily: Decodable {
            let time: [String]
            let code: [Int]
            let high: [Double]
            let low: [Double]

            private enum CodingKeys: String, CodingKey { case time, code = "weather_code", high = "temperature_2m_max", low = "temperature_2m_min" }
        }

        let current: Current
        let daily: Daily
    }

    private static func fetch(_ city: String) async throws -> Forecast {
        var search = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        search.queryItems = [.init(name: "name", value: city), .init(name: "count", value: "1"), .init(name: "language", value: "zh")]
        let (placeData, _) = try await URLSession.shared.data(from: search.url!)
        guard let place = try JSONDecoder().decode(Geocoding.self, from: placeData).results?.first else { throw URLError(.cannotFindHost) }
        var query = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        query.queryItems = [
            .init(name: "latitude", value: String(place.latitude)),
            .init(name: "longitude", value: String(place.longitude)),
            .init(name: "current", value: "temperature_2m,weather_code"),
            .init(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min"),
            .init(name: "forecast_days", value: "5"),
            .init(name: "timezone", value: "auto"),
        ]
        let (data, _) = try await URLSession.shared.data(from: query.url!)
        let raw = try JSONDecoder().decode(Raw.self, from: data)
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
        let days = raw.daily.time.indices.compactMap { index -> Forecast.Day? in
            guard let date = format.date(from: raw.daily.time[index]), index < raw.daily.code.count, index < raw.daily.high.count, index < raw.daily.low.count else { return nil }
            return Forecast.Day(date: date, code: raw.daily.code[index], high: raw.daily.high[index], low: raw.daily.low[index])
        }
        return Forecast(city: place.name, day: today, temperature: raw.current.temperature, code: raw.current.code, days: days)
    }
}
