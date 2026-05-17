export async function withRetry<T>(
  operation: () => Promise<T>,
  retries = 2,
  delayMs = 500
): Promise<T> {
  let currentError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      currentError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
      }
    }
  }

  throw currentError;
}
