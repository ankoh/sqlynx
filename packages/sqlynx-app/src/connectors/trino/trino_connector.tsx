import * as React from 'react';

import { TrinoClientInterface } from "./trino_api_client.js";

const API_CTX = React.createContext<TrinoClientInterface | null>(null);

export const useTrinoAPI = (): TrinoClientInterface => React.useContext(API_CTX)!;
