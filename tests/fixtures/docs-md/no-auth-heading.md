# Getting Started

## Installation

Install the SDK using npm:

```bash
npm install my-sdk
```

## Usage

Import and initialize the client:

```javascript
import { Client } from 'my-sdk'
const client = new Client({ apiUrl: 'https://api.example.com' })
```

## Rate Limiting

Requests are limited to 100 per minute per IP address.
