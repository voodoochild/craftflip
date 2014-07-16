var q = require('q');
var _ = require('lodash');
var request = require('request');
var elasticsearch = require('elasticsearch');
var client = new elasticsearch.Client();

// Local caches of recipes and pricing data.
var recipes = {};
var prices = {};

// Methods.
var getPrices, getRecipes, traverseRecipe, checkProfitable, rounded;

// Constants.
var LISTING_FEE = 0.95;
var SALES_TAX = 0.9;

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
 * Capitalize the first character of a string.
 */
String.prototype.capitalize = function() {
  return this.charAt(0).toUpperCase() + this.slice(1);
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
  if (!recipe || recipe.output_item.hasOwnProperty('acquisition')) { return; }

  recipe.output_item.prices = prices[recipe.output_item_id] || {};

  if (recipe.ingredients.length) {
    var craftedTotal = 0;
    _.forEach(recipe.ingredients, function (ingredient) {
      // Traverse ingredients with recipes, or assign prices to raw ingredients
      if (ingredient.recipe_id && recipes[ingredient.recipe_id]) {
        var ingredientRecipe = recipes[ingredient.recipe_id];
        traverseRecipe(ingredientRecipe);
        ingredient.item.prices = ingredientRecipe.output_item.prices;
      } else {
        ingredient.item.prices = prices[ingredient.item_id] || {};
        ingredient.item.acquisition = 'buy';
      }

      // Add crafted or sell price to the craftedTotal
      if (ingredient.item.prices.crafted) {
        craftedTotal += ingredient.item.prices.crafted * ingredient.count;
      } else {
        craftedTotal += (ingredient.item.prices.sell || 0) * ingredient.count;
      }
    });

    // Compare the combined price of the ingredients with the sell price
    craftedTotal = craftedTotal / recipe.output_item_count; // TODO: is this logic sound?
    if (craftedTotal < (recipe.output_item.prices.sell || 0)) {
      recipe.output_item.prices.crafted = craftedTotal;
      recipe.output_item.acquisition = 'craft';
    } else {
      recipe.output_item.acquisition = 'buy';
    }
  } else {
    // No ingredients, so buying is the only option
    recipe.output_item.acquisition = 'buy';
  }
};

/**
 * Check to see if a traversed recipe is profitable when crafted vs. highest buy order.
 */
checkProfitable = function (recipe) {
  var itemName = recipe.output_item.name;
  var acquiredBy = recipe.output_item.acquisition;
  if (!acquiredBy) {
    console.log(itemName, 'not traversed');
    return;
  }
  var prices = recipe.output_item.prices;
  var craftedPrice = prices && prices.crafted;
  var sellPrice = prices && prices.sell;
  var acquiredPrice = acquiredBy === 'crafted' ? craftedPrice : sellPrice;
  var spread = (prices.buy * SALES_TAX) - (prices.buy - (prices.buy * LISTING_FEE)) - acquiredPrice;

  // console.log('-'.repeat(10));
  // console.log(acquiredBy.capitalize(), itemName, 'for', rounded(acquiredPrice / 100) +'s');
  // console.log('Buy order is', rounded(prices.buy / 100) +'s');
  // console.log('Spread is', rounded(spread / 100) +'s');
  // console.log('-'.repeat(10), '\n');

  if (spread > 100) {
    console.log(itemName, rounded(spread/100));
  }
  //  else {
  //   console.log(itemName, 'no profit');
  // }
};

//=========================================================================//

// 1. Get all indexed recipes
getRecipes()

  // 2. Get pricing data
  .then(getPrices)

    // 3. Loop through recipes
    .then(function () {
      // _.forEach([recipes['1223']], function (recipe) {
      _.forEach(_.sample(recipes, 1000), function (recipe) {

        // 4. Traverse the top–level recipe
        traverseRecipe(recipe);

        // 5. Check to see if the recipe is profitable
        checkProfitable(recipe);
      });
    });

//=========================================================================//

/*
TODO:
  - hard–code list of prices for vendor items
  - handle items with no pricing data: what should happen?
 */
