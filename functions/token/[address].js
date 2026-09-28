// /token/<address> — legacy alias for the token detail page.
import { serveTokenPage } from '../_token-page.js';

export const onRequest = serveTokenPage;
