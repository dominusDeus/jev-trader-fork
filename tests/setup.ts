// Tests never load .env or use operator credentials.
process.env.DRY_RUN = "true";
process.env.PRIVATE_KEY = "";
process.env.MODEL = "mock";
process.env.TYPESAFE_AI_API_KEY = "";
