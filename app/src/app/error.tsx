"use client";
export default function ErrorPage({ reset }: { reset: () => void }) { return <main className="vendor"><h1>Something went wrong.</h1><p>Your details have not been sent. Please try again.</p><button onClick={reset}>Try again</button></main>; }
