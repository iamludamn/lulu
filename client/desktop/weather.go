package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/egoist/mygo/netproxy"
)

type forecastDay struct {
	Date time.Time
	Code int
	High float64
	Low  float64
}

type forecast struct {
	City        string
	Day         string
	Temperature float64
	Code        int
	Days        []forecastDay
}

type forecastState struct {
	value  *forecast
	failed bool
	at     time.Time
}

var weatherClient = &http.Client{Transport: netproxy.Transport(), Timeout: 20 * time.Second}

func weatherJSON(ctx context.Context, target string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	res, err := weatherClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("weather: %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func fetchForecast(ctx context.Context, city string) (*forecast, error) {
	var places struct {
		Results []struct {
			Name      string  `json:"name"`
			Latitude  float64 `json:"latitude"`
			Longitude float64 `json:"longitude"`
		} `json:"results"`
	}
	search := url.Values{"name": {city}, "count": {"1"}, "language": {"zh"}}
	if err := weatherJSON(ctx, "https://geocoding-api.open-meteo.com/v1/search?"+search.Encode(), &places); err != nil {
		return nil, err
	}
	if len(places.Results) == 0 {
		return nil, errors.New("unknown city")
	}
	place := places.Results[0]
	query := url.Values{
		"latitude":      {fmt.Sprint(place.Latitude)},
		"longitude":     {fmt.Sprint(place.Longitude)},
		"current":       {"temperature_2m,weather_code"},
		"daily":         {"weather_code,temperature_2m_max,temperature_2m_min"},
		"forecast_days": {"5"},
		"timezone":      {"auto"},
	}
	var raw struct {
		Current struct {
			Temperature float64 `json:"temperature_2m"`
			Code        int     `json:"weather_code"`
		} `json:"current"`
		Daily struct {
			Time []string  `json:"time"`
			Code []int     `json:"weather_code"`
			High []float64 `json:"temperature_2m_max"`
			Low  []float64 `json:"temperature_2m_min"`
		} `json:"daily"`
	}
	if err := weatherJSON(ctx, "https://api.open-meteo.com/v1/forecast?"+query.Encode(), &raw); err != nil {
		return nil, err
	}
	out := &forecast{City: place.Name, Day: time.Now().Format("2006-01-02"), Temperature: raw.Current.Temperature, Code: raw.Current.Code}
	for i, day := range raw.Daily.Time {
		date, err := time.ParseInLocation("2006-01-02", day, time.Local)
		if err != nil || i >= len(raw.Daily.Code) || i >= len(raw.Daily.High) || i >= len(raw.Daily.Low) {
			continue
		}
		out.Days = append(out.Days, forecastDay{Date: date, Code: raw.Daily.Code[i], High: raw.Daily.High[i], Low: raw.Daily.Low[i]})
	}
	return out, nil
}

type weatherLook struct {
	icon string
	text string
}

func lookOf(code int) weatherLook {
	switch {
	case code == 0:
		return weatherLook{"sun", "晴"}
	case code == 1:
		return weatherLook{"sun", "大部晴朗"}
	case code == 2:
		return weatherLook{"cloud", "多云"}
	case code == 3:
		return weatherLook{"cloud", "阴"}
	case code == 45 || code == 48:
		return weatherLook{"cloud", "雾"}
	case code >= 51 && code <= 57:
		return weatherLook{"rain", "毛毛雨"}
	case code == 61 || code == 63 || code == 65:
		return weatherLook{"rain", "雨"}
	case code == 66 || code == 67:
		return weatherLook{"rain", "冻雨"}
	case (code >= 71 && code <= 77) || code == 85 || code == 86:
		return weatherLook{"snow", "雪"}
	case code >= 80 && code <= 82:
		return weatherLook{"rain", "阵雨"}
	case code >= 95 && code <= 99:
		return weatherLook{"zap", "雷暴"}
	}
	return weatherLook{"cloud", "未知"}
}

func (a *app) forecastFor(city string) forecastState {
	today := time.Now().Format("2006-01-02")
	if f, ok := a.weather[city]; ok && (f.failed && time.Since(f.at) < 2*time.Minute || f.value != nil && f.value.Day == today) {
		return f
	}
	if a.weatherLoading[city] {
		return a.weather[city]
	}
	a.weatherLoading[city] = true
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		value, err := fetchForecast(ctx, city)
		a.win.Update(func() {
			delete(a.weatherLoading, city)
			if err != nil {
				a.weather[city] = forecastState{failed: true, at: time.Now()}
				return
			}
			a.weather[city] = forecastState{value: value}
		})
	}()
	return a.weather[city]
}
