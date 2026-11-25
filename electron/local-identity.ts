import { userInfo } from 'node:os';

const readLocalIdentity = () => {
  try {
    const username = userInfo().username.trim();
    return username ? { name: username } : { name: '' };
  } catch {
    return { name: '' };
  }
};

export { readLocalIdentity };
