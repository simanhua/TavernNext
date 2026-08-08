import { useEffect, useState } from 'react';

type HealthResponse = {
  app: string;
  status: string;
};

export function App() {
  const [health, setHealth] = useState('Checking local API…');

  useEffect(() => {
    void fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health check failed: ${response.status}`);
        }

        return response.json() as Promise<HealthResponse>;
      })
      .then((response) => setHealth(`${response.app} is ${response.status}`))
      .catch(() => setHealth('Local API is unavailable'));
  }, []);

  return (
    <main>
      <h1>TavernNext</h1>
      <p>{health}</p>
    </main>
  );
}
