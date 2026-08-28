# Rides, surprise boxes and pushable crates

Date: 2026-08-28
Status: approved, in implementation

## Why

The game has three pickups (range, bubble, skate) and one kind of destructible
crate. This adds the things that make the original feel alive: something to ride
that makes you fast, something to ride that makes you slow, a gamble box, and
crates you can shove around.

## Prerequisite: one sim, not two

`index.html` currently carries its own complete copy of the simulation for
single-player while the server runs `game-core.js`. Three consecutive movement
fixes went into one copy and not the other. Adding four features to both by hand
would repeat that.

Single-player switches to `BB.makeWorld()` — the same core the relay runs.
The page keeps input, rendering, sound and menus; it loses `update`, `reset`,
`buildMap`, `makePlayer`, `botPlan`, `placeBubble`, `burst`, the whole bot AI,
and the movement helpers. Each frame single-player does what the online path
already does with a snapshot: step the world, read `world.read()` into the
render globals, and play sounds from the returned event list.

A test guards it: the movement suite fails if `index.html` grows a
`function update(` again.

## Rides

`p.ride` is `null`, `'car'` or `'turtle'`. Both lie on the floor as items and are
mounted by finishing a step onto their tile. A ride is lost when its rider is
trapped by a bubble, and not otherwise.

Tile time is `moveDur(p)` scaled by the ride, with a floor so a maxed skater in a
car stays steerable:

| ride    | factor | floor  | at speed 0 | at speed 5 |
|---------|--------|--------|------------|------------|
| none    | 1.0    | —      | 0.200s     | 0.138s     |
| car     | 0.70   | 0.120s | 0.140s     | 0.120s     |
| turtle  | 1.90   | —      | 0.380s     | 0.262s     |

`TAP_HOLD` is unchanged, so one press is still one tile at every one of these
speeds.

## Items

The pickup pool grows to six types, rolled when a popped crate drops something
(`POWERUP_CHANCE` unchanged at 0.36):

| item        | weight |
|-------------|--------|
| range       | 22%    |
| bubble      | 22%    |
| skate       | 18%    |
| car         | 12%    |
| turtle      | 14%    |
| surprise    | 12%    |

A turtle on the floor is a hazard to walk around, the counterweight to the car.

The surprise box rolls when touched: 25% range, 25% bubble, 15% skate, 15% car,
15% turtle, 5% nothing. The roll happens inside the sim, so every player online
sees the same outcome.

## Pushable crates

A third grid value, `CRATE`, alongside `FLOOR`, `WALL` and `BARREL`. Roughly one
barrel in eight becomes a crate at map build, drawn with a rope so it reads as
movable.

Walking into a crate slides it one tile in the direction of travel and the
pusher steps in behind it — only when the tile beyond is empty floor: not a
wall, crate, barrel, bubble, or another sailor. The push and the step are one
move, so it still costs exactly one tap.

A crate blocks a blast and pops like a barrel, dropping from the same item pool.
Bots treat crates as walls: they neither push nor path through them, so they
cannot wedge themselves.

## HUD

The ride joins the stat line when you have one:
`💧1/8  🫧1/8  👟1/6  🏎   ·   Sailors 4`.

## Tests

`tools/items-test.js`, against the core:

- a car and a turtle each change the tile time by the table above, at speed 0 and speed 5
- mounting takes the item off the floor; a second sailor cannot mount it after
- being trapped removes the ride; being freed does not give it back
- 2000 surprise rolls stay inside the pool and hit every outcome
- a crate pushes into free floor, and refuses a wall, a crate, a barrel, a bubble and a sailor
- the pusher ends up on the crate's old tile
- a pushed crate still stops a blast
- a bot never pushes a crate

`tools/movement-test.js` keeps its single-player rows on the core once the page
has no sim of its own, plus the one-sim guard.
