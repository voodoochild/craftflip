var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

// Local caches of recipes and pricing data.
var recipes = {};
var prices = {};

// Methods.
var getPrices, getRecipes, traverseRecipe, rounded;

/**
 * Repeat a string {count} times.
 */
String.prototype.repeat = function (count) {
  if (count < 1) { return ''; }
  var result = '', pattern = this.valueOf();
  while (count > 1) {
    if (count & 1) { result += pattern; }
    count >>= 1, pattern += pattern;
  }
  return result + pattern;
};

/**
 * Round a float to two decimal places.
 */
rounded = function (num) {
  var sign = num >= 0 ? 1 : -1;
  return (Math.round((num * Math.pow(10, 2)) + (sign  *0.001)) / Math.pow(10, 2)).toFixed(2);
};

/**
 * Retrieve all pricing data from gw2tp.com.
 */
getPrices = function () {
  var deferred = q.defer();
  request({
      url: 'http://api.gw2tp.com/1/bulk/items.json',
      json: true
  }, function (error, response, body) {
    _.forEach(body.items, function (item) {
      item = _.zipObject(body.columns, item);
      prices[item.id] = { buy: item.buy, sell: item.sell };
    });
    deferred.resolve();
  });
  return deferred.promise;
};

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
    _.forEach(results.hits.hits, function (hit) { recipes[hit._id] = hit._source; });
    client.close();
    deferred.resolve();
  });
  return deferred.promise;
};

/**
 * Traverse a recipe, calculating crafting prices.
 */
traverseRecipe = function (recipe) {
  console.log('Traversing '+ recipe.output_item.name);
  if (!recipe || recipe.output_item.hasOwnProperty('acquisition')) { return; }

  recipe.output_item.prices = prices[recipe.output_item_id] || {};

  if (recipe.ingredients.length) {
    var craftedTotal = 0;
    _.forEach(recipe.ingredients, function (ingredient) {
      console.log('--'+ ingredient.item.name);
      // Traverse ingredients with recipes, or assign prices to raw ingredients
      if (ingredient.recipe_id && recipes[ingredient.recipe_id]) {
        var ingredientRecipe = recipes[ingredient.recipe_id];
        traverseRecipe(ingredientRecipe);
        ingredient.item.prices = ingredientRecipe.output_item.prices;
      } else {
        ingredient.item.prices = prices[ingredient.item_id] || {};
        ingredient.item.acquisition = 'buy';
        console.log('Buy '+ ingredient.item.name +' for '+ ingredient.item.prices.sell +', it isn\'t craftable');
      }

      // console.log(ingredient.item.name, ingredient.item.prices);

      // Add crafted or sell price to the craftedTotal
      if (ingredient.item.prices.crafted) {
        craftedTotal += ingredient.item.prices.crafted * ingredient.count;
      } else {
        craftedTotal += (ingredient.item.prices.sell || 0) * ingredient.count;
      }
    });

    // Compare the combined price of the ingredients with the sell price
    if (craftedTotal < (recipe.output_item.prices.sell || 0)) {
      recipe.output_item.prices.crafted = rounded(craftedTotal);
      recipe.output_item.acquisition = 'craft';
      console.log('Craft '+ recipe.output_item.name +' for '+ recipe.output_item.prices.crafted);
    } else {
      recipe.output_item.acquisition = 'buy';
      console.log('Buy '+ recipe.output_item.name +' for '+ recipe.output_item.prices.sell +', crafting costs '+ craftedTotal);
    }
  } else {
    // No ingredients, so buying is the only option
    recipe.output_item.acquisition = 'buy';
    console.log('Buy '+ recipe.output_item.name +' for '+ recipe.output_item.prices.sell +', no ingredients');
  }
};

//=========================================================================//

// 1. Get all indexed recipes
getRecipes()

  // 2. Get pricing data
  .then(getPrices)

    // 3. Loop through recipes
    .then(function () {
      // _.forEach([recipes['1223']], function (recipe) {
      _.forEach(_.sample(recipes, 2), function (recipe) {

        // 4. Traverse the top–level recipe
        traverseRecipe(recipe);
        console.log('\n', '*'.repeat(20), '\n');
        // console.log(
        //   recipe.output_item.acquisition, recipe.output_item.name, 'for',
        //   (recipe.output_item.acquisition === 'crafted') ?
        //     rounded(recipe.output_item.prices.crafted/100)+'s' : rounded(recipe.output_item.prices.sell/100)+'s'
        // );
      });
    });

//=========================================================================//

/*
TODO:
  - hard–code list of prices for vendor items
  - handle items with no pricing data: what should happen?
 */
