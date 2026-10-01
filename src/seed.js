/**
 * Creates the seed groups / VK users from config on an empty database.
 * Existing rows are never touched.
 */
export function seedDatabase({ repo, config, logger }) {
  const created = { groups: [], vk_users: [] };

  if (Array.isArray(config.seed?.groups) && repo.listGroups().length === 0) {
    for (const entry of config.seed.groups) {
      try {
        created.groups.push(repo.createGroup(entry ?? {}));
      } catch (error) {
        logger?.warn(`seed group failed: ${error.message}`);
      }
    }
  }

  if (Array.isArray(config.seed?.vk_users) && repo.listVkUsers().length === 0) {
    for (const entry of config.seed.vk_users) {
      try {
        created.vk_users.push(repo.createVkUser(entry ?? {}));
      } catch (error) {
        logger?.warn(`seed vk user failed: ${error.message}`);
      }
    }
  }

  return created;
}
