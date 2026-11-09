# The Bridge of Lodi (10 May 1796): sources and choices

`src/data/lodi.json`. Scale: 1 unit = 10 m. The Adda runs north-south; Lodi and the French are on the **west** bank, the Austrians on the **east** bank, so the French attack east.

## What the scenario takes from the sources
Wikipedia (Battle of Lodi), napoleon-series.org (virtual tour), Warlord Games (history note).

| Fact | In the scenario |
|---|---|
| Fighting from about 9 am, the assault at about 6 pm after hours of bombardment | clock 16:30 to 19:30 over 600 s; the "about six o'clock" note fires at t = 290 s (18:00) |
| Bridge about 200 yards long, wooden, on piles | 17-unit river crossed by a narrow chain of dry discs (a regiment must funnel into column) |
| Austrians tried to destroy it; French guns firing along it stopped them | the bridge is intact |
| Sebottendorf's division, 14 guns (six on a slight slope facing the bridge, the rest enfilading) | 14 guns: a battery of 6 on a small rise at the bridge head, 4 each on the flanks; a gentle hill east of the bridge |
| First line: 2 bns Carlstädter Grenz, Warasdiner Grenz (1,262), Nádasdy IR 39 (623) | as named, with those strengths (Carlstädter 730 each is derived: see below) |
| Second line: Terzi IR 16 (3 bns, 1,212), Belgiojoso IR 44 (311), Thurn IR 43 (622), 4 sqn Archduke Joseph Hussars, 2 sqn Mészáros Uhlans (286) | as named; Terzi as 3 units of 404 |
| French advance guard under Dallemagne, about 3,000 elite; four grenadier battalions under Lannes; the 2nd battalion of carabiniers leads the assault | 4 grenadier units (520 each) and a carabinier unit (400) already in Lodi |
| About 24 French guns sited by Bonaparte | 6 batteries of 4 guns |
| Masséna's division, then Augereau's, come up; Masséna, Berthier, Cervoni and Dallemagne lead the second rush | Masséna (t = 120 s) and Augereau (t = 360 s) arrive with three line units each; the generals appear as the commander units Masséna and Augereau |
| Beaumont and Ordener's cavalry sent upstream to a ford | three cavalry units sent at t = 240 s to a shallow stretch of the river north of the town (the real ford was several kilometres upstream, brought in to fit the map) |
| Nicoletti (Corte Palasio) and the Neapolitan cavalry (Fontana) were detached, not at the bridge | not on the map |

## Where sources disagree, or the number is derived
- **Austrian strength:** 6,577 (Wikipedia's order of battle, excluding Nicoletti and the Neapolitans) against 9,500 to about 12,000 elsewhere. The scenario uses the order of battle, so about 6,600 of the 7,000 men on the map are infantry and cavalry.
- **Carlstädter battalions (730 each):** not given. Derived as what remains of 6,577 after the other named units, hussars and gunners are subtracted.
- **Hussars (480):** estimated for 4 squadrons.
- **Austrian guns at the bridge:** 12 in one account, 14 in others, and 24 appear in a Warlord/napoleon-series passage that seems to refer to the French battery. The scenario uses 14 and 24.
- **Napoleon laying the guns himself, and the "little corporal" nickname:** unsupported by contemporary evidence (the Wikipedia article says so). The scenario does not claim it.
- **One attack or two:** sources disagree. The scenario lets the French try more than once.
- **Casualties:** about 350 French (qualified "arguably"); Austrians about 153 dead, 1,700 captured, 16 guns. The sim does not model a withdrawal at nightfall, so its Austrian losses are higher than the historical ones.

## Game design choices (not history)
- The Austrians win by holding the bridge to t = 480 s (about 19:00); the French win by taking it first, or on points if time runs out.
- French cavalry are modelled as the `lancer` type (light cavalry stand-in), likewise the Austrian hussars and uhlans.
- Grenz battalions are ordinary `line` units.
