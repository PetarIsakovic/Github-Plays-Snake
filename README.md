# GitHub Plays Snake

One snake. Everyone controls it.

A snake game that lives inside a GitHub README. Anyone who visits can click an arrow to vote. Every minute the snake moves the way most people voted.

<p align="center"><img src="docs/images/board-dark.png" width="420" alt="GitHub Plays Snake board"></p>

## How it works

The board is an SVG image made by a server. The image uses `ismap` so clicking it sends the click position to the server. The server counts your vote and sends you back to GitHub. No JavaScript needed.

The backend runs on AWS with Lambda and DynamoDB. A scheduler moves the snake when the round ends.

## Run it locally

```bash
npm install
npm run dev
```

Then open http://localhost:8787

## Run the tests

```bash
npm test
```

## Deploy your own

You need an AWS account and the AWS CLI set up.

```bash
PROFILE_URL=https://github.com/YOUR_USERNAME npm run deploy
npm run snippet
```

Paste what `npm run snippet` prints into your profile README.

## Notes

- Voting works on laptops and desktops. Phones can watch but not vote.
- Votes are anonymous so it is best effort. One vote per person per round.
- It costs less than a dollar a month for small traffic.

## Credits

Inspired by [Placefile](https://github.com/cnrad/placefile) and [Twitter Plays Snake](https://github.com/PolyMarsDev/Twitter-Plays-Snake).

MIT License
