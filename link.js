var q = require('q');
var _ = require('lodash');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

// Methods. All of them return a promise.
var getRecipes, getRecipeForItem, updateRecipe;

// Cache relationships between items and recipes.
var itemsRecipes = {};

/**
 * Retrieve all indexed recipes.
 */
getRecipes = function () {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 9000
  }).then(function (results) {
    deferred.resolve(_.pluck(results.hits.hits, '_source'));
  });
  return deferred.promise;
};

/**
 * Try to find a recipe that outputs the specified item.
 */
getRecipeForItem = function (itemId) {
  var deferred = q.defer();
  if (itemsRecipes.hasOwnProperty(itemId)) {
    deferred.resolve(itemsRecipes[itemId]);
  } else {
    client.search({
      index: 'gw2',
      type: 'recipe',
      size: 1,
      body: {
        query: {
          match: {
            output_item_id: itemId
          }
        }
      }
    }).then(function (results) {
      var recipeId = results.hits.total ? results.hits.hits[0]._id : null;
      itemsRecipes[itemId] = recipeId;
      recipeId ? deferred.resolve(recipeId) : deferred.resolve(null);
    });
  }
  return deferred.promise;
};

/**
 * Update an indexed recipe.
 */
updateRecipe = function (recipe) {
  return client.index({
    index: 'gw2',
    type: 'recipe',
    id: recipe.recipe_id,
    body: recipe
  });
};

//=========================================================================//

// 1. Get all indexed recipes
getRecipes()

  // 2. Loop through recipes
  .then(function (recipes) {
    _.forEach(recipes, function (recipe) {

      // 3. Loop through ingredients
      var itemPromises = [];
      var itemIds = _.pluck(recipe.ingredients, 'item_id');

      // 4. Try to find a recipe that outputs this ingredient
      _.forEach(itemIds, function (itemId) {
        itemPromises.push(getRecipeForItem(itemId));
      });

      // 5. Link recipe ids to ingredients
      q.all(itemPromises)
        .then(function (recipeIds) {
          _.forEach(recipeIds, function (recipeId, i) {
            recipe.ingredients[i].recipe_id = recipeId;
          });

          // 6. Update the recipe index
          updateRecipe(recipe)

            // 7. Done!
            .then(function () {
              console.log('SUCCESS '+ recipe.output_item.name);
            }).catch(function (error) {
              console.log('ERROR '+ recipe.output_item.name, error);
            });
        });
    });
  });

//=========================================================================//
