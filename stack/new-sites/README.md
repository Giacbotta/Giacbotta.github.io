# New sites: one example

Post 11 is about looking for new locations with Python scripts that read public sources, and keep reading them.

The full set runs privately: about a dozen scripts on a schedule, hourly readings, months of raw data. What is here is one of them, as it runs, plus a small extract of what it produces.

## What is in here

| File | Contents |
| --- | --- |
| `bounce_occupancy.py` | Reads how full the Bounce luggage points are, city by city, across Italy. One public GraphQL request per city, no login, standard library only. |
| `sample-bounce-daily-city.csv` | One week (15 to 21 November 2026), the 8 Italian cities with the most Bounce capacity. |

## How to read the sample

One row per city per day.

- `points`: Bounce points in the city.
- `capacity`: total bags those points declare.
- `peak`, `peak_pct`: highest number of bags in storage at one reading, and as a share of capacity.
- `last`: bags in storage at the last reading of the day.
- `arrivals`: rises in the curve between readings. A floor, not a count of bookings.

## Why it matters

- Occupancy per city is the number I could not get anywhere else.
- It turns "where should the next site be" from a feeling into a ranking.
- It costs about 120 requests per round for the whole country.

## Run it

```
python bounce_occupancy.py cities
python bounce_occupancy.py scan venice,florence
python bounce_occupancy.py daily
```

Output goes to `data/` next to the script.
