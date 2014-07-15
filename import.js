var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

// Methods. All of them return a promise.
var getRecipeIds, getItemDetails, getRecipeDetails, filterIndexedRecipes, checkIsSuitable, indexRecipe;

// Build up a local cache of data from various API responses.
var recipes = {};
var items = {};

/**
 * Get a list of all discovered recipes.
 */
getRecipeIds = function () {
  var deferred = q.defer();
  request({
    url: 'https://api.guildwars2.com/v1/recipes.json',
    json: true
  }, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      deferred.resolve(body.recipes);
    } else {
      deferred.reject(error);
    }
  });
  return deferred.promise;
};

/**
 * Filter out any recipes that have already been indexed.
 */
filterIndexedRecipes = function (recipes) {
  var deferred = q.defer();
  client.search({
    index: 'gw2',
    type: 'recipe',
    size: 9000
  }).then(function (results) {
    var indexedRecipes = _.map(results.hits.hits, function (hit) { return parseInt(hit._id, 10); });
    recipes = _.difference(recipes, indexedRecipes);
    console.info(recipes.length ? 'Indexing '+ recipes.length +' recipes' : 'All recipes already indexed');
    deferred.resolve(recipes);
  });
  return deferred.promise;
};

/**
 * Get details for a specific recipe.
 */
getRecipeDetails = function (recipeId) {
  var deferred = q.defer();
  if (recipes.hasOwnProperty(recipeId)) {
    deferred.resolve(recipes[recipeId]);
  } else {
    request({
      url: 'https://api.guildwars2.com/v1/recipe_details.json',
      qs: {recipe_id: recipeId},
      json: true
    }, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        recipes[recipeId] = body;
        deferred.resolve(body);
      } else {
        deferred.reject(error);
      }
    });
  }
  return deferred.promise;
};

/**
 * Get details for a specific item.
 */
getItemDetails = function (itemId) {
  var deferred = q.defer();
  if (items.hasOwnProperty(itemId)) {
    deferred.resolve(items[itemId]);
  } else {
    request({
      url: 'https://api.guildwars2.com/v1/item_details.json',
      qs: {item_id: itemId},
      json: true
    }, function (error, response, body) {
      if (!error && response.statusCode === 200) {
        items[itemId] = body;
        deferred.resolve(body);
      } else {
        deferred.reject(error);
      }
    });
  }
  return deferred.promise;
};

/**
 * Check to see whether or not a recipe has properties which make it unsuitable.
 * @TODO – apply redFlags to ingredients as well
 */
checkIsSuitable = function (recipe) {
  var deferred = q.defer();
  var redFlags = [
    recipe.output_item.name.match(/\+\d+ Agony Infusion/),
    recipe.output_item.rarity === 'Ascended',
    recipe.output_item.rarity === 'Legendary',
    recipe.output_item.rarity === 'Junk',
    recipe.min_rating > 400,
    recipe.output_item.type === 'Bag',
    _.indexOf(recipe.output_item.flags, 'AccountBound') > -1,
    _.indexOf(recipe.output_item.flags, 'SoulboundOnAcquire') > -1
  ];
  if (_.compact(redFlags).length) {
    deferred.reject(recipe);
  } else {
    deferred.resolve(recipe);
  }
  return deferred.promise;
};

/**
 * Index a recipe in elasticsearch.
 */
indexRecipe = function (recipe) {
  client.index({
    index: 'gw2',
    type: 'recipe',
    id: recipe.recipe_id,
    body: recipe
  }).then(function () {
    console.log('SUCCESS '+ recipe.output_item.name);
  }).catch(function () {
    console.log('ERROR '+ recipe.output_item.name);
  });
};

//=========================================================================//

// 1. Get discovered recipe ids
getRecipeIds()

  // 2. Filter out recipes that are already in the index
  .then(filterIndexedRecipes)

    // 3. Loop through recipe ids
    .then(function (recipeIds) {
      _.forEach(recipeIds.slice(0, 1), function (recipeId) {

        // 4. Get details for a specific recipe
        getRecipeDetails(recipeId).then(function (recipe) {
          var itemPromises = [];
          var itemIds = _.pluck(recipe.ingredients, 'item_id');
          itemIds.push(recipe.output_item_id);

          // 5. Get details for the output item and any ingredients
          _.forEach(itemIds, function (itemId) {
            itemPromises.push(getItemDetails(itemId));
          });

          // 6. Integrate item data into the recipe
          q.all(itemPromises)
            .then(function () {
              recipe.output_item = items[recipe.output_item_id];
              _.forEach(recipe.ingredients, function (ingredient) {
                ingredient.item = items[ingredient.item_id];
              });

              // 7. Check to see if this recipe is suitable for further processing
              checkIsSuitable(recipe)

                // 8. Index recipe in elasticsearch
                .then(indexRecipe);
            });
        });
      });
    });

//=========================================================================//
